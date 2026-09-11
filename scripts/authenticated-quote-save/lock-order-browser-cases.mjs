import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { loadAcceptanceProofWire } from './versioned-acceptance-browser-cases.mjs'

// Test-only orchestration. Actual Save UI and canonical acceptance HTTP calls
// compete in P/O. R2 is a separately labelled native transaction, never an HTTP
// acknowledgement. Control owns observed PostgreSQL locks, not response mocks.
const ids = ['P1', 'P2', 'O1', 'O2', 'R1', 'R2']
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const paths = ['/api/baseline', '/api/save', '/api/acceptance/preview', '/api/acceptance/commit', '/api/acceptance/reconcile']
const authCookie = cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
async function bounded(work, label, ms = 30000) {
  let timer
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms) })]) }
  finally { clearTimeout(timer) }
}
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparable(item)]))
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value))
    return value.replace(/(?:Z|\+00:00)$/, '+00:00').replace(/(\.\d*?[1-9])0+(?=\+)/, '$1').replace(/\.0+(?=\+)/, '')
  return value
}
function unchangedOutside(before, after, allowed) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  for (const key of Object.keys(before)) if (key !== 'ownerA') assert.deepEqual(after[key], before[key], 'Control owner/shared rows changed: ' + key)
  assert.deepEqual(Object.keys(after.ownerA).sort(), Object.keys(before.ownerA).sort())
  for (const [table, rows] of Object.entries(before.ownerA)) if (!allowed.includes(table)) assert.deepEqual(after.ownerA[table], rows, 'Unintended table mutation: ' + table)
}
function newRow(before, after, table) {
  const prior = new Map(before.ownerA[table].map(row => [row.id, row])), added = []
  for (const row of after.ownerA[table]) {
    if (prior.has(row.id)) { assert.deepEqual(row, prior.get(row.id)); prior.delete(row.id) } else added.push(row)
  }
  assert.equal(prior.size, 0, 'Existing ' + table + ' rows removed'); assert.equal(added.length, 1, 'Exactly one new ' + table + ' row')
  return added[0]
}
function documentMatches(document, rows, fixture, notes) {
  const q = rows.ownerA.quotes[0]
  assert.equal(document.quote_id, fixture.quoteA); assert.equal(document.notes, notes); assert.equal(document.terms_text, fixture.termsA)
  assert.equal(document.status, 'sent'); assert.equal(document.offered_option_id, null); assert.deepEqual(document.options, [])
  for (const field of ['customer_name', 'quote_number', 'address', 'service_type', 'valid_until', 'initial_price', 'travel_fee', 'addons_total',
    'total', 'weekly_price', 'biweekly_price', 'monthly_price', 'deposit_type', 'deposit_value', 'selected_option_id']) assert.deepEqual(document[field], q[field], 'Public native field: ' + field)
  assert.equal(document.company_name, rows.ownerA.business_settings[0].company_name); assert.equal(document.gst_percent, rows.ownerA.business_settings[0].gst_percent)
  assert.deepEqual(document.included_addon_ids, [fixture.addonIdsA[0]]); assert.deepEqual(document.addons.map(row => row.id), fixture.addonIdsA)
  for (const table of ['services', 'addons']) {
    const stored = rows.ownerA['quote_' + table]; assert.equal(document[table].length, stored.length)
    for (let index = 0; index < stored.length; index++) for (const [field, value] of Object.entries(document[table][index])) assert.deepEqual(value, stored[index][field])
  }
  assert.equal(JSON.stringify(document).includes(q.internal_notes), false)
}
function acceptedRows(before, after, receipt, intent, fixture, facts, owner) {
  unchangedOutside(before, after, ['quotes', 'quote_addons', 'quote_acceptances', 'audit_events', 'notifications'])
  const q = after.ownerA.quotes[0], ledger = newRow(before, after, 'quote_acceptances'), document = intent.expected.offered.public
  assert.equal(after.ownerA.quotes.length, 1); assert.equal(after.ownerA.quote_acceptances.length, 1)
  assert.equal(receipt.code, 'accepted'); assert.equal(receipt.quote_id, fixture.quoteA); assert.equal(q.status, 'accepted')
  assert.equal(q.accepted_price, document.accepted_amount); assert.equal(q.notes, before.ownerA.quotes[0].notes)
  for (const [field, value] of Object.entries(before.ownerA.quotes[0]))
    if (!['status', 'accepted_price', 'accepted_after_followup', 'follow_up_count_at_acceptance', 'updated_at'].includes(field)) assert.deepEqual(q[field], value, 'Acceptance quote field: ' + field)
  assert.equal(q.accepted_after_followup, Number(before.ownerA.quotes[0].follow_up_count ?? 0) > 0)
  assert.equal(q.follow_up_count_at_acceptance, before.ownerA.quotes[0].follow_up_count ?? 0)
  const kind = owner ? 'owner_on_behalf' : 'customer', actor = owner ? fixture.ownerA : fixture.customerA, source = owner ? 'dashboard' : 'portal'
  for (const [field, value] of Object.entries({ id: receipt.acceptance_id, user_id: fixture.ownerA, quote_id: fixture.quoteA, seq: 1,
    kind, source, actor_type: owner ? 'owner' : 'customer', actor_id: actor, customer_id: fixture.customerA,
    accepted_amount: document.accepted_amount, selected_option_id: null, supersedes_id: null,
    terms_required: true, terms_acknowledged: true, terms_text: fixture.termsA,
    on_behalf_reason: owner ? intent.reason : null, on_behalf_note: owner ? intent.note : null })) assert.deepEqual(ledger[field], value, 'Native ledger field: ' + field)
  for (const field of ['kind', 'source', 'actor_id', 'customer_id', 'accepted_amount', 'selected_option_id']) assert.deepEqual(receipt[field], ledger[field])
  assert.equal(receipt.acceptance_seq, ledger.seq); assert.equal(receipt.previous_acceptance_id, null)
  assert.equal(facts.acceptanceCurrent, true)
  assert.equal(receipt.document_fingerprint, facts.documentFingerprint); assert.equal(ledger.document_fingerprint, facts.documentFingerprint)
  assert.equal(receipt.terms_fingerprint, facts.termsFingerprint); assert.equal(ledger.terms_fingerprint, facts.termsFingerprint)
  for (const field of ['quote_number', 'customer_name', 'address', 'service_type', 'notes', 'initial_price', 'travel_fee', 'total', 'valid_until', 'deposit_type', 'deposit_value']) assert.deepEqual(ledger.document[field], q[field])
  assert.deepEqual(ledger.document.option, null); assert.deepEqual(ledger.document.options_offered, [])
  assert.deepEqual(receipt.addon_ids, intent.addonIds); assert.deepEqual(ledger.document.addons.map(row => row.id).sort(), intent.addonIds)
  const addons = after.ownerA.quote_addons
  assert.deepEqual(addons.map(row => row.id), fixture.addonIdsA); assert.deepEqual(addons.filter(row => row.is_selected).map(row => row.id).sort(), intent.addonIds)
  for (let index = 0; index < addons.length; index++) {
    for (const [field, value] of Object.entries(before.ownerA.quote_addons[index]))
      if (!['selected_via', 'selected_at', 'updated_at'].includes(field)) assert.deepEqual(addons[index][field], value)
    assert.equal(addons[index].selected_via, index === 0 ? owner ? 'owner' : 'portal' : null); assert.equal(addons[index].selected_at !== null, index === 0)
  }
  assert.equal(ledger.document.services.length, after.ownerA.quote_services.length)
  for (let index = 0; index < ledger.document.services.length; index++) for (const [field, value] of Object.entries(ledger.document.services[index])) assert.deepEqual(value, after.ownerA.quote_services[index][field])
  const audit = newRow(before, after, 'audit_events'), notification = newRow(before, after, 'notifications')
  for (const [field, value] of Object.entries({ user_id: fixture.ownerA, action: owner ? 'quote_acceptance_recorded' : 'quote_accepted', entity_type: 'quote', entity_id: fixture.quoteA, customer_id: fixture.customerA })) assert.deepEqual(audit[field], value)
  assert.equal(audit.before.status, 'sent'); assert.equal(audit.after.status, 'accepted'); assert.equal(audit.after.acceptance_kind, kind); assert.equal(audit.after.accepted_price, document.accepted_amount)
  for (const [field, value] of Object.entries({ user_id: fixture.ownerA, type: 'quote_accepted', entity_type: 'quote', entity_id: fixture.quoteA,
    customer_id: fixture.customerA, amount: q.total, href: '/dashboard/quotes/' + fixture.quoteA })) assert.deepEqual(notification[field], value)
}

export async function runLockOrderBrowser({ browser, baseURL, fixtures, createControl, readRows, readFacts, readFreshOwnerRows }) {
  const report = { pass: false, tests: [], schedules: [], contexts: [], failures: [], evidence: [],
    scope: 'Four real HTTP/native Save-versus-acceptance lock schedules, one real HTTP settings-revocation schedule and one explicit native transaction revocation schedule.',
    limits: ['Acceptance is browser HTTP, not an acceptance UI.', 'R2 function return is provisional until normal outer COMMIT; it is not an HTTP acknowledgement.',
      'Only declared business-table inventories and shared units are compared; Auth rows and private portal tokens are excluded.',
      'No cancellation, early response or elapsed time is accepted as proof of rollback or ordering.'] }
  const secrets = (fixtures ?? []).flatMap(f => [f.password, f.portalTokenA, f.portalTokenB, f.revokedPortalTokenA]).filter(value => typeof value === 'string' && value.length > 0)
  const safe = error => {
    let value = String(error instanceof Error ? error.message : error)
    for (const secret of secrets) value = value.replaceAll(secret, '[private fixture value]')
    return value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[private token]').slice(0, 1400)
  }
  try {
    assert.equal(baseURL, 'http://localhost:3000'); assert.equal(browser.browserType().name(), 'chromium'); assert.equal(browser.isConnected(), true)
    assert.deepEqual(fixtures.map(f => f.id), ids)
    for (const callback of [createControl, readRows, readFacts, readFreshOwnerRows]) assert.equal(typeof callback, 'function')
    assert.equal(new Set(fixtures.map(f => f.ownerA)).size, 6); assert.equal(new Set(fixtures.map(f => f.quoteA)).size, 6)
    const { wire, evidence } = await loadAcceptanceProofWire(); report.evidence.push(evidence); report.browserVersion = browser.version()
    for (const fixture of fixtures) {
      const entry = { id: fixture.id, pass: false, phases: [], requests: [], evidence: [], cleanup: {}, beforeRows: fixture.before }
      report.schedules.push(entry)
      const pair = /^[PO]/.test(fixture.id), portal = fixture.id.startsWith('P'), saveFirst = fixture.id.endsWith('1') && pair
      const note = 'Observed lock schedule ' + fixture.id + ' owner scope V2'
      const contexts = [], tasks = [], responses = [], saves = [], acceptanceCommits = [], pending = []
      let control, phase = 'preparation', ownerPage, acceptancePage, preview, intent, baseline, initialFacts, finalRows, finalFacts, successful = false
      const check = async (name, work) => {
        phase = name
        try { await work(); entry.phases.push({ name, pass: true }) }
        catch (error) { entry.phases.push({ name, pass: false, error: safe(error) }); throw error }
      }
      const track = promise => {
        const state = { unresolved: true }
        state.promise = Promise.resolve(promise).then(result => { state.unresolved = false; return result }, error => { state.unresolved = false; throw error })
        void state.promise.catch(() => {}); pending.push(state); return state
      }
      const rows = () => bounded(() => readRows(fixture), 'Independent rows ' + fixture.id)
      const facts = async () => {
        const value = await bounded(() => readFacts(fixture), 'Native facts ' + fixture.id)
        assert.deepEqual(Object.keys(value).sort(), ['acceptanceCurrent', 'documentFingerprint', 'termsFingerprint'])
        assert.match(value.documentFingerprint, /^[a-f0-9]{32}$/); assert.match(value.termsFingerprint, /^[a-f0-9]{32}$/); assert.equal(typeof value.acceptanceCurrent, 'boolean')
        return value
      }
      const inspectURL = raw => {
        for (const secret of secrets) assert.equal(raw.includes(secret), false, 'Private value appeared in URL')
        const url = new URL(raw), origin = url.origin.replace(/^ws:/, 'http:')
        assert.ok(['http:', 'ws:'].includes(url.protocol) && [baseURL, 'http://127.0.0.1:8000'].includes(origin), 'Unexpected origin')
        return url
      }
      const pageFor = async label => {
        const observed = { schedule: fixture.id, label, opened: false, closed: false }; report.contexts.push(observed)
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' })
        contexts.push({ context, observed }); observed.opened = true; context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(45000)
        context.on('request', request => {
          try {
            const url = inspectURL(request.url())
            entry.requests.push({ label, phase, method: request.method(), origin: url.origin, path: url.pathname })
            if (url.origin === baseURL && request.method() === 'POST' && ['/api/save', '/api/acceptance/commit'].includes(url.pathname)) {
              const body = request.postDataJSON()
              if (body?.quoteId === fixture.quoteA) {
                if (url.pathname === '/api/save') saves.push(body)
                else acceptanceCommits.push({ operationId: body.clientOperationId, digest: sha(body) })
              }
            }
          } catch (error) { report.failures.push({ schedule: fixture.id, kind: 'request', error: safe(error) }) }
        })
        context.on('response', response => {
          const url = new URL(response.url())
          if (url.origin !== baseURL || !paths.includes(url.pathname) || response.request().method() !== 'POST') return
          tasks.push((async () => {
            try {
              const body = await bounded(() => response.json(), 'Observed API body', 20000)
              for (const secret of secrets) assert.equal(JSON.stringify(body).includes(secret), false, 'Private value appeared in API response')
              responses.push({ label, path: url.pathname, status: response.status(), body, noStore: response.headers()['cache-control'] === 'no-store' })
            } catch (error) { report.failures.push({ schedule: fixture.id, kind: 'response', error: safe(error) }) }
          })())
        })
        context.on('requestfailed', request => {
          const url = new URL(request.url())
          if (url.origin === baseURL && paths.includes(url.pathname)) report.failures.push({ schedule: fixture.id, kind: 'request-failed', path: url.pathname })
        })
        const page = await context.newPage()
        page.on('pageerror', error => report.failures.push({ schedule: fixture.id, kind: 'page', error: safe(error) }))
        page.on('websocket', socket => { try { inspectURL(socket.url()) } catch (error) { report.failures.push({ schedule: fixture.id, kind: 'websocket', error: safe(error) }) } })
        return { page, context }
      }
      const drain = async () => { let count; do { count = tasks.length; await Promise.all(tasks) } while (count !== tasks.length) }
      const counts = async () => {
        for (const id of ['closed-count', 'reconciliation-count']) assert.equal((await ownerPage.page.getByTestId(id).textContent())?.trim(), '0')
      }
      const login = async target => {
        await target.page.goto(baseURL + '/login?quoteId=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
        await target.page.waitForFunction(() => document.querySelector('[data-testid="login-ready"]')?.textContent === 'ready')
        await target.page.getByLabel('Email', { exact: true }).fill(fixture.emailA); await target.page.getByLabel('Password', { exact: true }).fill(fixture.password)
        await Promise.all([target.page.waitForURL(url => url.origin === baseURL && url.pathname === '/quote' && url.searchParams.get('quoteId') === fixture.quoteA),
          target.page.getByRole('button', { name: 'Sign in', exact: true }).click()])
        await target.page.locator('textarea[name="notes"]').waitFor({ state: 'visible' })
        assert.ok((await target.context.cookies()).some(authCookie))
      }
      const post = (target, path, body) => target.page.evaluate(async ({ path, body }) => {
        const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return { status: response.status, body: await response.json(), noStore: response.headers.get('cache-control') === 'no-store' }
      }, { path, body })
      const refused = (result, status, reason, request) => {
        assert.equal(result.status, status); assert.equal(result.noStore, true)
        assert.deepEqual(result.body, { code: 'refused', ...(request ? { clientOperationId: request.clientOperationId, previewRevision: request.expected.previewRevision } : {}), reason })
        assert.ok(request ? wire.parsePilotAcceptanceCommitReply(result.body, request, portal ? undefined : fixture.ownerA)
          : wire.parsePilotAcceptancePreview(result.body, { version: 1, quoteId: fixture.quoteA, optionId: null }))
      }
      const save = () => {
        const response = ownerPage.page.waitForResponse(r => {
          const url = new URL(r.url()); if (url.origin !== baseURL || url.pathname !== '/api/save' || r.request().method() !== 'POST') return false
          return r.request().postDataJSON()?.quoteId === fixture.quoteA
        }).then(async r => ({ status: r.status(), body: await r.json(), noStore: r.headers()['cache-control'] === 'no-store', intent: r.request().postDataJSON() }))
        const state = track(Promise.all([response, ownerPage.page.locator('button[type="submit"]:visible').click()]).then(([result]) => result))
        return state
      }
      const parseAccepted = result => {
        assert.equal(result.status, 200); assert.equal(result.noStore, true)
        const parsed = wire.parsePilotAcceptanceCommitReply(result.body, intent, portal ? undefined : fixture.ownerA)
        assert.ok(parsed?.code === 'accepted'); return parsed.receipt
      }
      const verifyRevoked = async expectedRows => {
        const request = { version: 1, quoteId: fixture.quoteA, optionId: null }
        refused(await post(acceptancePage, '/api/acceptance/preview', request), 403, 'forbidden')
        const next = { ...intent, clientOperationId: randomUUID() }
        refused(await post(acceptancePage, '/api/acceptance/commit', next), 403, 'forbidden', next)
        const reconciled = await post(acceptancePage, '/api/acceptance/reconcile', intent)
        assert.equal(reconciled.status, 503); assert.equal(reconciled.noStore, true)
        assert.deepEqual(reconciled.body, { code: 'unknown', clientOperationId: intent.clientOperationId, previewRevision: intent.expected.previewRevision })
        const deniedSave = await save().promise
        assert.equal(deniedSave.status, 403); assert.equal(deniedSave.noStore, true); assert.deepEqual(deniedSave.body, { code: 'forbidden' })
        assert.equal(await ownerPage.page.locator('textarea[name="notes"]').inputValue(), note)
        assert.equal(await ownerPage.page.getByText('Submitted version saved', { exact: true }).count(), 0); await counts()
        assert.deepEqual(await rows(), expectedRows)
        entry.evidence.push({ kind: 'revoked-owner-current-actions', preview: 403, commit: 403, save: 403, reconcile: 503, reconciliation: 'unknown', allCapturedRowsUnchanged: true })
      }
      try {
        await check('prepare actual authenticated editor and immutable native V1; warm only invalid requests', async () => {
          for (const field of ['ownerA', 'quoteA', 'customerA']) assert.ok(uuid(fixture[field]))
          assert.equal(fixture.acceptanceVersioned, true); assert.ok(fixture.termsA.trim()); assert.equal(fixture.before.ownerA.quote_acceptances.length, 0)
          assert.equal(Object.keys(fixture.before.ownerA).length, 23)
          ownerPage = await pageFor('owner-save'); await login(ownerPage)
          if (pair) {
            acceptancePage = await pageFor(portal ? 'portal' : 'owner-acceptance')
            if (portal) { await acceptancePage.page.goto(baseURL + '/login?quoteId=' + fixture.quoteA); assert.equal((await acceptancePage.context.cookies()).filter(authCookie).length, 0) }
            else await login(acceptancePage)
          } else acceptancePage = ownerPage
          await drain()
          const loaded = responses.filter(r => r.label === 'owner-save' && r.path === '/api/baseline').at(-1)
          assert.ok(loaded); assert.equal(loaded.status, 200); assert.equal(loaded.noStore, true); baseline = loaded.body
          assert.equal(baseline.code, 'baseline'); assert.equal(baseline.ownerId, fixture.ownerA); assert.equal(baseline.quoteId, fixture.quoteA)
          const request = { version: 1, quoteId: fixture.quoteA, optionId: null, ...(portal ? { portalToken: fixture.portalTokenA } : {}) }
          const result = await post(acceptancePage, '/api/acceptance/preview', request)
          assert.equal(result.status, 200); assert.equal(result.noStore, true); preview = wire.parsePilotAcceptancePreview(result.body, request)
          assert.ok(preview?.code === 'preview'); assert.equal(preview.expected.priorAcceptanceId, null); assert.equal(preview.expected.priorAcceptanceSeq, null)
          documentMatches(preview.expected.offered.public, fixture.before, fixture, fixture.before.ownerA.quotes[0].notes)
          freeze(preview)
          intent = freeze(wire.buildPilotAcceptanceCommitRequest(request, preview.expected, { addonIds: preview.expected.offered.public.included_addon_ids,
            reason: portal ? null : 'text_message', note: portal ? null : 'Synthetic explicit lock-order acceptance', termsAck: true, clientOperationId: randomUUID() }))
          for (const path of ['/api/save', '/api/acceptance/commit']) {
            const warm = await post(ownerPage, path, {}); assert.equal(warm.status, 400); assert.equal(warm.noStore, true)
            assert.equal(warm.body.code, path === '/api/save' ? 'invalid_request' : 'refused')
            if (path !== '/api/save') assert.equal(warm.body.reason, 'invalid_request')
          }
          await ownerPage.page.locator('textarea[name="notes"]').fill(note)
          const form = ownerPage.page.locator('form').filter({ has: ownerPage.page.locator('input[name="initial_price"]') })
          assert.equal(await form.evaluate(node => node.noValidate), false); assert.equal(await form.evaluate(node => node.checkValidity()), true)
          await counts(); await drain(); assert.deepEqual(await rows(), fixture.before); initialFacts = await facts(); assert.equal(initialFacts.acceptanceCurrent, false)
          assert.equal(saves.length, 0); assert.equal(acceptanceCommits.length, 0)
          control = await createControl(fixture)
          entry.evidence.push({ kind: 'prepared-v1', baselineDigest: sha(baseline), previewDigest: sha(preview), initialFacts, formValidationBypassed: false, warmupWrites: 0 })
        })
        if (pair) {
          await check('observe both actual native waits before releasing the quote-only gate', async () => {
            await control.beginQuoteGate()
            const startAcceptance = () => track(post(acceptancePage, '/api/acceptance/commit', intent))
            const first = saveFirst ? save() : startAcceptance()
            await control.waitFirst(saveFirst ? 'save' : 'acceptance', () => first.unresolved)
            const second = saveFirst ? startAcceptance() : save()
            const graph = await control.waitPair(saveFirst ? 'save' : 'acceptance', saveFirst ? 'acceptance' : 'save', () => first.unresolved && second.unresolved)
            assert.equal(first.unresolved && second.unresolved, true); assert.deepEqual(await rows(), fixture.before)
            assert.equal(first.unresolved && second.unresolved, true); await control.releaseGate()
            const [firstResult, secondResult] = await Promise.all([first.promise, second.promise])
            const saveResult = saveFirst ? firstResult : secondResult, acceptanceResult = saveFirst ? secondResult : firstResult
            assert.equal(saveResult.noStore, true); assert.equal(saveResult.intent.expectedEditorRevision, baseline.editorRevision); assert.equal(saveResult.intent.values.notes, note)
            finalRows = await rows(); finalFacts = await facts()
            if (saveFirst) {
              assert.equal(saveResult.status, 200)
              const pendingSave = { version: 1, owner: fixture.ownerA, quoteId: fixture.quoteA, clientOperationId: saveResult.intent.clientOperationId,
                editorGeneration: saveResult.intent.editorGeneration, originalEditorRevision: baseline.editorRevision, submittedValues: saveResult.intent.values,
                submittedSerialization: JSON.stringify(saveResult.intent.values), stagedAt: Date.now(), state: 'pending' }
              const receipt = wire.parsePilotQuoteSaveReceipt(saveResult.body, pendingSave); assert.ok(receipt)
              assert.equal(receipt.acceptance_current, false); assert.notEqual(receipt.after_revision, receipt.before_revision)
              refused(acceptanceResult, 409, 'quote_changed', intent)
              unchangedOutside(fixture.before, finalRows, ['quotes', 'quote_services'])
              assert.equal(finalRows.ownerA.quotes[0].notes, note); assert.equal(finalRows.ownerA.quotes[0].status, 'sent'); assert.equal(finalRows.ownerA.quote_acceptances.length, 0)
              for (const [field, value] of Object.entries(receipt.quote)) assert.deepEqual(comparable(finalRows.ownerA.quotes[0][field]), comparable(value))
              assert.deepEqual(comparable(finalRows.ownerA.quote_services), comparable(receipt.services)); assert.deepEqual(finalRows.ownerA.quote_services.map(row => row.sort_order), [0, 1, 2])
              assert.equal(finalFacts.acceptanceCurrent, false); assert.notEqual(finalFacts.documentFingerprint, initialFacts.documentFingerprint); assert.equal(finalFacts.termsFingerprint, initialFacts.termsFingerprint)
              await ownerPage.page.getByText('Submitted version saved', { exact: true }).waitFor({ state: 'visible' })
              const fresh = await post(acceptancePage, '/api/acceptance/preview', { version: 1, quoteId: fixture.quoteA, optionId: null, ...(portal ? { portalToken: fixture.portalTokenA } : {}) })
              assert.equal(fresh.status, 200); assert.equal(fresh.noStore, true)
              const parsed = wire.parsePilotAcceptancePreview(fresh.body, { version: 1, quoteId: fixture.quoteA, optionId: null, ...(portal ? { portalToken: fixture.portalTokenA } : {}) })
              assert.ok(parsed?.code === 'preview'); assert.notEqual(parsed.expected.previewRevision, preview.expected.previewRevision); documentMatches(parsed.expected.offered.public, finalRows, fixture, note)
              assert.deepEqual(await rows(), finalRows)
            } else {
              const receipt = parseAccepted(acceptanceResult)
              assert.equal(saveResult.status, 409); assert.deepEqual(saveResult.body, { code: 'stale_editor' })
              acceptedRows(fixture.before, finalRows, receipt, intent, fixture, finalFacts, !portal)
              assert.deepEqual(finalFacts, { ...initialFacts, acceptanceCurrent: true })
              assert.equal(await ownerPage.page.locator('textarea[name="notes"]').inputValue(), note)
              assert.equal(await ownerPage.page.getByText('Submitted version saved', { exact: true }).count(), 0)
            }
            await counts()
            entry.evidence.push({ kind: 'actual-http-pair', graph, saveStatus: saveResult.status, acceptanceStatus: acceptanceResult.status,
              saveResponseDigest: sha(saveResult.body), acceptanceResponseDigest: sha(acceptanceResult.body), finalRowsDigest: sha(finalRows), finalFacts,
              saveOperationId: saveResult.intent.clientOperationId, acceptanceOperationId: intent.clientOperationId, nativeTransactionsOwnedByPostgrest: true })
          })
          await check('fresh actual Auth and PostgREST observe the winner without replay', async () => {
            const fresh = await bounded(() => readFreshOwnerRows(fixture), 'Fresh owner readback')
            assert.equal(fresh.ownerId, fixture.ownerA); assert.deepEqual(comparable(fresh.quote), comparable(finalRows.ownerA.quotes[0]))
            assert.deepEqual(comparable(fresh.services), comparable(finalRows.ownerA.quote_services)); assert.deepEqual(await rows(), finalRows)
            entry.evidence.push({ kind: 'fresh-owner-readback', quoteDigest: sha(fresh.quote), servicesDigest: sha(fresh.services), browserSessionReused: false })
          })
        } else if (fixture.id === 'R1') {
          await check('observe native acceptance blocked behind uncommitted settings deletion', async () => {
            await control.beginSettingsDeletion()
            const operation = track(post(acceptancePage, '/api/acceptance/commit', intent))
            const graph = await control.waitFirst('acceptance', () => operation.unresolved)
            assert.equal(operation.unresolved, true); assert.deepEqual(await rows(), fixture.before)
            assert.equal(operation.unresolved, true); await control.releaseGate()
            refused(await operation.promise, 403, 'forbidden', intent)
            finalRows = await rows(); finalFacts = await facts(); unchangedOutside(fixture.before, finalRows, ['business_settings'])
            assert.deepEqual(finalRows.ownerA.business_settings, []); assert.equal(finalRows.ownerA.quote_acceptances.length, 0); assert.equal(finalFacts.acceptanceCurrent, false)
            entry.evidence.push({ kind: 'deletion-first', graph, onlySettingsDeleted: true, nativeRefusal: 'forbidden', status: 403, finalFacts })
          })
          await check('current owner authority is denied without altering revoked fixture state', () => verifyRevoked(finalRows))
        } else {
          await check('native acceptance COMMIT precedes blocked settings deletion, with an intermediate committed snapshot', async () => {
            const provisional = await control.beginNativeAcceptance(intent)
            assert.equal(provisional.code, 'accepted'); assert.equal(provisional.quote_id, fixture.quoteA)
            assert.deepEqual(await rows(), fixture.before); assert.deepEqual(await facts(), initialFacts)
            await control.startDeletionBehindNative(); const graph = await control.waitDeletionLock()
            assert.deepEqual(await rows(), fixture.before); await control.commitNative()
            const deletion = await control.finishDeletion(); assert.deepEqual(deletion, { deletedRows: 1, committed: false })
            const intermediate = await rows(), intermediateFacts = await facts()
            acceptedRows(fixture.before, intermediate, provisional, intent, fixture, intermediateFacts, true)
            assert.deepEqual(intermediate.ownerA.business_settings, fixture.before.ownerA.business_settings)
            assert.deepEqual(intermediateFacts, { ...initialFacts, acceptanceCurrent: true })
            entry.acceptedBeforeDeletionRows = intermediate
            await control.commitDeletion(); finalRows = await rows(); finalFacts = await facts()
            unchangedOutside(intermediate, finalRows, ['business_settings']); assert.deepEqual(finalRows.ownerA.business_settings, [])
            assert.equal(finalFacts.acceptanceCurrent, false); assert.equal(finalFacts.documentFingerprint, intermediateFacts.documentFingerprint)
            assert.notEqual(finalFacts.termsFingerprint, intermediateFacts.termsFingerprint)
            entry.evidence.push({ kind: 'acceptance-first-native-transaction', graph, provisionalReturnDigest: sha(provisional), httpAcknowledgementClaimed: false,
              acceptedBeforeDeletionDigest: sha(intermediate), intermediateFacts, finalFacts, durableLedgerPreserved: true })
          })
          await check('revocation denies later owner actions without erasing the committed acceptance', () => verifyRevoked(finalRows))
        }
        await check('exact valid attempts and unchanged terminal state; no automatic replay', async () => {
          await drain(); assert.equal(saves.length, 1); assert.equal(saves[0].quoteId, fixture.quoteA); assert.equal(saves[0].values.notes, note)
          assert.equal(acceptanceCommits.length, pair ? 1 : fixture.id === 'R1' ? 2 : 1)
          if (fixture.id !== 'R2') assert.deepEqual(acceptanceCommits[0], { operationId: intent.clientOperationId, digest: sha(intent) })
          if (portal) assert.equal((await acceptancePage.context.cookies()).filter(authCookie).length, 0)
          for (const request of entry.requests) if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
            assert.ok(request.method === 'POST' && (request.origin === baseURL && paths.includes(request.path)
              || request.origin === 'http://127.0.0.1:8000' && request.label !== 'portal' && ['/auth/v1/token', '/rest/v1/rpc/current_app_role'].includes(request.path)), 'Unexpected browser write path')
          assert.ok(responses.every(r => r.noStore)); assert.equal(report.failures.some(f => f.schedule === fixture.id), false)
          assert.deepEqual(await rows(), finalRows); assert.deepEqual(await facts(), finalFacts); await counts()
          entry.afterRows = finalRows; entry.control = control.snapshotEvidence()
        })
        successful = true
      } catch (error) {
        entry.error = { phase, message: safe(error) }
        try { entry.failureRowsBeforeCleanup = await bounded(() => readRows(fixture), 'Failure state before cleanup', 5000) } catch (failure) { entry.failureReadBefore = safe(failure) }
      } finally {
        if (control) {
          try { entry.cleanup.control = await control.close(); entry.control = control.snapshotEvidence(); if (entry.cleanup.control?.pass !== true) successful = false }
          catch (error) { entry.cleanup.controlError = safe(error); successful = false }
        }
        try { await bounded(() => Promise.allSettled(pending.map(item => item.promise)), 'Drain owned HTTP operations', 20000); entry.cleanup.requestsDrained = pending.every(item => !item.unresolved) }
        catch (error) { entry.cleanup.drainError = safe(error); successful = false }
        if (!successful) {
          try { entry.failureRowsAfterCleanup = await bounded(() => readRows(fixture), 'Failure state after cleanup', 5000) } catch (failure) { entry.failureReadAfter = safe(failure) }
          entry.cleanup.cancellationProvesRollback = false
        }
        for (const { context, observed } of contexts.reverse()) {
          try { await context.close(); observed.closed = true } catch (error) { entry.cleanup.contextError = safe(error); successful = false }
        }
        try { await drain() } catch (error) { entry.cleanup.observationError = safe(error); successful = false }
        entry.cleanup.contextsClosed = contexts.every(item => item.observed.closed)
        entry.pass = successful && entry.cleanup.contextsClosed && entry.cleanup.requestsDrained && !report.failures.some(f => f.schedule === fixture.id)
        report.tests.push({ name: fixture.id + ' observed lock schedule', pass: entry.pass, ...(entry.error ? { error: entry.error.message } : {}) })
      }
      if (!entry.pass) break // Stop admission; a failed order never becomes a sequential fallback.
    }
    report.allOpenedContextsClosed = report.contexts.every(item => item.opened && item.closed)
    report.pass = report.tests.length === 6 && report.tests.every(test => test.pass) && report.allOpenedContextsClosed && report.failures.length === 0
  } catch (error) { report.error = safe(error) }
  return report
}
