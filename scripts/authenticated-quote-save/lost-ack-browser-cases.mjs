import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Test-only delivery failure: the driver holds an authentic canonical response.
// Nothing in this module supplies that receipt to the editor, intercepts a
// request, modifies storage, replaces a handler, or reconstructs Save policy.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const submittedNote = 'Submitted once before the real response was lost'
const newerNote = 'Newer unsaved typing while the committed response is held'
const unknownMessage = 'We could not confirm this Save. Your submitted copy and current edits are kept. Review recovery before saving again.'
const blockedMessage = 'An earlier Save needs review. Your current edits are still here.'
const eventKinds = ['save-request', 'native-commit-dispatch', 'native-commit-return', 'committed-response-held', 'sql-commit-observed', 'response-dropped']
const exactNumbers = { initial_price: 101.23, hours: 1.13, rate: 37.17, measured_sqft: 1234.56 }

// Compare native timestamp spelling only. Preserve PG fractional precision,
// array order, JSON values and amounts; no pricing or identity calculations.
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, comparable(child)]))
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) {
    return value.replace(/(?:Z|\+00:00)$/, '+00:00').replace(/(\.\d*?[1-9])0+(?=\+)/, '$1').replace(/\.0+(?=\+)/, '')
  }
  return value
}

async function bounded(work, label, milliseconds = 60_000) {
  let timer
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/**
 * The caller owns Browser/platform/fault teardown. This module owns four fresh
 * contexts; owner A reloads and signs in again in its SAME context/storage.
 * readIndependentRows() is an independent SQL readFixture, not a receipt cache.
 * readFreshOwnerRows() uses a new real credential session and ordered PostgREST
 * SELECTs, returning {ownerId, quote, services}. Both are read-only observers.
 */
export async function runLostAcknowledgementBrowser({ browser, baseURL, fixture, readIndependentRows, readFreshOwnerRows, fault }) {
  const report = { pass: false, tests: [], evidence: [], requests: [], failures: [], contexts: [], allContextsClosed: false,
    browserOwnedByCaller: true,
    scope: 'One actual authenticated canonical Save commits normally; an isolated delivery fault loses its response. Actual editor recovery remains UNKNOWN with no automatic replay.',
    limits: ['Driver owns platform, fault, Browser and process provenance/closure.',
      'Independent SQL and fresh Auth/PostgREST attest current saved facts, not attributable product reconciliation.',
      'No durable server operation journal or reconciliation endpoint is introduced or claimed.',
      'Local recovery is demonstrated in the same browser origin/storage, not across devices or cleared storage.',
      'Unchanged-row checks cover the fixture readback inventory; minimal generated CSS is not production visual parity.'] }
  const contexts = [], responses = [], tasks = [], saveBodies = [], decodeFailures = [], apiRequestFailures = []
  const requestMap = new WeakMap()
  let phase = 'validate isolated harness', intent, receipt, afterSave, initialPending, unknownPendingBytes, preservedDraftBytes, heldBrowserResponse
  let observedEvents = [], released = false
  const safeError = error => String(error instanceof Error ? error.message : 'Unknown browser failure')
    .replaceAll(String(fixture?.password ?? '__no_password__'), '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]').slice(0, 1000)
  const check = async (name, work) => {
    phase = name
    try { await work(); report.tests.push({ name, pass: true }) }
    catch (error) { report.tests.push({ name, pass: false, error: safeError(error) }); throw error }
  }
  const inspectURL = raw => {
    const url = new URL(raw), origin = url.origin.replace(/^ws:/, 'http:')
    assert.ok(['http:', 'ws:'].includes(url.protocol) && [baseURL, 'http://127.0.0.1:8000'].includes(origin), 'Unexpected browser origin')
    return url
  }
  const faultEvents = async () => {
    const raw = await bounded(() => fault.readEvents(), 'Fault event read')
    assert.ok(Array.isArray(raw) && raw.length <= 20, 'Bounded fault events required')
    const next = raw.map(event => {
      assert.ok(event && typeof event === 'object' && !Array.isArray(event))
      assert.ok(Object.keys(event).every(key => ['kind', 'at', 'operationId', 'observedDigest'].includes(key)), 'Unexpected fault evidence field')
      assert.ok(eventKinds.includes(event.kind), 'Unexpected fault event kind')
      assert.ok(typeof event.at === 'number' && Number.isFinite(event.at)
        || typeof event.at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(event.at), 'Bounded event timestamp required')
      if (event.operationId !== undefined) { assert.ok(uuid(event.operationId)); if (intent) assert.equal(event.operationId, intent.clientOperationId) }
      if (event.kind === 'sql-commit-observed') {
        assert.match(event.observedDigest ?? '', /^[0-9a-f]{64}$/)
        if (afterSave) assert.equal(event.observedDigest, digest(afterSave), 'SQL barrier must bind the independently observed complete rows')
      } else assert.equal(event.observedDigest, undefined)
      return { kind: event.kind, at: event.at, ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(event.observedDigest === undefined ? {} : { observedDigest: event.observedDigest }) }
    })
    assert.deepEqual(next.slice(0, observedEvents.length), observedEvents, 'Fault event history must be append-only')
    assert.deepEqual(next.map(event => event.kind), eventKinds.slice(0, next.length), 'Fault ordering/count must be exact')
    observedEvents = next
    return next
  }
  const drain = async () => { let count; do { count = tasks.length; await Promise.all(tasks) } while (count !== tasks.length) }
  const newPage = async label => {
    const entry = { name: label, attempted: true, opened: false, closed: false }
    report.contexts.push(entry)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' })
    contexts.push({ context, entry }); entry.opened = true
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(45_000)
    context.on('request', request => {
      try {
        const url = inspectURL(request.url()), entry = { context: label, method: request.method(), origin: url.origin, path: url.pathname }
        report.requests.push(entry); requestMap.set(request, entry)
        // Only the synthetic quote intent is inspected. Never Auth POST bodies.
        if (url.origin === baseURL && url.pathname === '/api/save' && request.method() === 'POST') saveBodies.push({ context: label, body: request.postDataJSON() })
      } catch (error) { report.failures.push({ kind: 'request-boundary', error: safeError(error) }) }
    })
    context.on('requestfailed', request => {
      const entry = requestMap.get(request)
      if (entry?.origin === baseURL && ['/api/save', '/api/baseline'].includes(entry.path)) apiRequestFailures.push({ context: label, path: entry.path })
    })
    context.on('response', response => {
      const entry = requestMap.get(response.request())
      if (entry) entry.status = response.status()
      const url = new URL(response.url())
      if (url.origin !== baseURL || !['/api/save', '/api/baseline'].includes(url.pathname)) return
      tasks.push((async () => {
        try {
          const body = await bounded(() => response.json(), 'Observed API body', 90_000)
          responses.push({ context: label, path: url.pathname, status: response.status(), body,
            noStore: /(?:^|,)\s*no-store(?:\s|,|$)/.test(response.headers()['cache-control'] ?? '') })
        } catch (error) {
          if (error instanceof Error && error.message === 'Observed API body timed out') report.failures.push({ kind: 'api-body-observer-timeout', context: label, path: url.pathname })
          else decodeFailures.push({ context: label, path: url.pathname })
        }
      })())
    })
    const page = await context.newPage()
    page.on('pageerror', error => report.failures.push({ kind: 'page-error', context: label, error: safeError(error) }))
    page.on('websocket', socket => { try { inspectURL(socket.url()) } catch (error) { report.failures.push({ kind: 'websocket-boundary', error: safeError(error) }) } })
    return { context, page }
  }
  const signIn = async (page, email, quoteId) => {
    await page.goto(baseURL + '/login?quoteId=' + quoteId, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-testid="login-ready"]')?.textContent === 'ready')
    assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true)
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(fixture.password)
    await Promise.all([page.waitForURL(url => url.origin === baseURL && url.pathname === '/quote' && url.searchParams.get('quoteId') === quoteId),
      page.getByRole('button', { name: 'Sign in', exact: true }).click()])
  }
  const authCookieDigest = async context => {
    const cookies = (await context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name))
    assert.ok(cookies.length > 0, 'Actual canonical Auth cookie required')
    // Hash only private cookie bytes in runner memory; never emit the values.
    return digest(cookies.map(cookie => [cookie.name, cookie.value]).sort(([a], [b]) => a.localeCompare(b)))
  }
  const counts = async page => {
    assert.equal((await page.getByTestId('closed-count').textContent())?.trim(), '0', 'No unsolicited close')
    assert.equal((await page.getByTestId('reconciliation-count').textContent())?.trim(), '0', 'No fabricated reconciliation or replay')
    assert.equal(await page.getByText('Submitted version saved', { exact: true }).count(), 0, 'No false direct acknowledgement')
    assert.equal(await page.getByText('Direct Save acknowledgement recorded', { exact: true }).count(), 0)
  }
  const assertOneWrite = async () => {
    assert.equal(saveBodies.length, 1, 'No second browser Save')
    assert.equal(saveBodies[0].context, 'ownerA'); assert.deepEqual(saveBodies[0].body, intent)
    const events = await faultEvents()
    assert.equal(events.filter(event => event.kind === 'save-request').length, 1)
    assert.equal(events.filter(event => event.kind === 'native-commit-dispatch').length, 1)
  }
  const pendingKey = () => `eq:quote-save:pending:${fixture.ownerA}:${fixture.quoteA}:${intent.clientOperationId}`
  const draftKey = () => `eq:autosave:owner:${fixture.ownerA}:quote:${fixture.quoteA}:pilot:${intent.editorGeneration}`
  const readCopies = page => page.evaluate(({ pendingKey, draftKey, owner, quoteId }) => {
    const pendingKeys = [], committedKeys = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(`eq:quote-save:pending:${owner}:${quoteId}:`)) pendingKeys.push(key)
      if (key?.startsWith(`eq:quote-save:committed:${owner}:${quoteId}:`)) committedKeys.push(key)
    }
    return { pendingKeys, committedKeys, pending: localStorage.getItem(pendingKey), draft: localStorage.getItem(draftKey) }
  }, { pendingKey: pendingKey(), draftKey: draftKey(), owner: fixture.ownerA, quoteId: fixture.quoteA })
  const assertCopies = async (page, expectedState, expectedNote, frozen = false) => {
    const copies = await readCopies(page)
    assert.deepEqual(copies.pendingKeys, [pendingKey()]); assert.deepEqual(copies.committedKeys, [])
    const pending = JSON.parse(copies.pending), draft = JSON.parse(copies.draft)
    assert.equal(pending.version, 1); assert.equal(pending.owner, fixture.ownerA); assert.equal(pending.quoteId, fixture.quoteA)
    assert.equal(pending.clientOperationId, intent.clientOperationId); assert.equal(pending.editorGeneration, intent.editorGeneration)
    assert.equal(pending.originalEditorRevision, intent.expectedEditorRevision); assert.equal(pending.state, expectedState)
    assert.equal(pending.submittedSerialization, JSON.stringify(intent.values)); assert.deepEqual(pending.submittedValues, intent.values)
    if (initialPending) assert.deepEqual({ ...pending, state: 'pending' }, initialPending)
    assert.equal(draft.version, 2); assert.equal(draft.owner, fixture.ownerA); assert.equal(draft.recordId, fixture.quoteA)
    assert.equal(draft.generation, intent.editorGeneration); assert.equal(draft.originalRevision, intent.expectedEditorRevision)
    assert.equal(draft.serialization, JSON.stringify(draft.value)); assert.equal(draft.value.notes, expectedNote)
    assert.deepEqual({ ...draft.value, notes: submittedNote }, intent.values, 'Only deliberate newer notes may differ from the submitted copy')
    if (frozen) { assert.equal(copies.pending, unknownPendingBytes); assert.equal(copies.draft, preservedDraftBytes) }
    return { copies, pending, draft }
  }
  const review = async page => {
    await page.getByRole('button', { name: 'Review saved and local copies', exact: true }).click()
    await page.getByRole('region', { name: 'Recovery review', exact: true }).waitFor({ state: 'visible' })
    await page.getByText('Earlier Save — outcome not confirmed', { exact: true }).waitFor({ state: 'visible' })
    await counts(page)
  }
  const savedRead = async page => {
    const before = responses.filter(response => response.context === 'ownerA' && response.path === '/api/baseline').length
    await page.getByRole('button', { name: 'Refresh saved version', exact: true }).click()
    const latest = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Latest saved version$/ }) })
    await latest.waitFor({ state: 'visible' })
    if (!await latest.evaluate(node => node.open)) await latest.locator('summary').click()
    await latest.getByText(submittedNote, { exact: true }).waitFor({ state: 'visible' })
    await drain()
    assert.ok(responses.filter(response => response.context === 'ownerA' && response.path === '/api/baseline').length > before)
    await counts(page); await assertOneWrite()
  }
  const baselineRefusal = async (page, quoteId, status, code) => {
    const result = await page.evaluate(async quoteId => {
      const response = await fetch('/api/baseline', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, quoteId }) })
      return { status: response.status, body: await response.json(), noStore: response.headers.get('cache-control') === 'no-store' }
    }, quoteId)
    assert.deepEqual(result, { status, body: { code }, noStore: true })
  }
  try {
    assert.equal(baseURL, 'http://localhost:3000'); assert.equal(browser.browserType().name(), 'chromium'); assert.equal(browser.isConnected(), true)
    for (const method of ['waitCommitted', 'releaseAfterReadback', 'readEvents']) assert.equal(typeof fault?.[method], 'function')
    assert.equal(typeof readIndependentRows, 'function'); assert.equal(typeof readFreshOwnerRows, 'function')
    for (const key of ['ownerA', 'ownerB', 'denied', 'quoteA', 'quoteB', 'quoteDenied']) assert.ok(uuid(fixture[key]), 'Fixture UUID ' + key)
    assert.equal(new Set([fixture.ownerA, fixture.ownerB, fixture.denied]).size, 3)
    assert.ok(fixture.before?.ownerA && fixture.before.ownerB && fixture.before.denied)
    report.browserVersion = browser.version()
    const a = await newPage('ownerA')
    await check('real owner A loads the verified baseline without mutating fixture rows', async () => {
      await signIn(a.page, fixture.emailA, fixture.quoteA)
      await a.page.locator('textarea[name="notes"]').waitFor({ state: 'visible' })
      await drain()
      const baseline = responses.filter(response => response.context === 'ownerA' && response.path === '/api/baseline').at(-1)
      assert.ok(baseline); assert.equal(baseline.status, 200); assert.equal(baseline.body.code, 'baseline')
      assert.equal(baseline.body.ownerId, fixture.ownerA); assert.equal(baseline.body.quoteId, fixture.quoteA); assert.equal(baseline.noStore, true)
      assert.ok((await a.context.cookies()).some(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)), 'Actual canonical Auth cookie required')
      assert.deepEqual(await bounded(readIndependentRows, 'Before-Save SQL read'), fixture.before)
      await counts(a.page)
      report.evidence.push({ kind: 'real-owner-baseline', baselineDigest: digest(baseline.body), actualCookiePresent: true, businessRowsUnchanged: true })
    })
    await check('one real Save is held after commit while newer typing is durably separate from the exact submission', async () => {
      await a.page.locator('textarea[name="notes"]').fill(submittedNote)
      const form = a.page.locator('form').filter({ has: a.page.locator('input[name="initial_price"]') })
      assert.equal(await form.evaluate(node => node.noValidate), false); assert.equal(await form.evaluate(node => node.checkValidity()), true)
      const responseReady = a.page.waitForResponse(response => new URL(response.url()).origin === baseURL
        && new URL(response.url()).pathname === '/api/save' && response.request().method() === 'POST', { timeout: 60_000 })
      ;[heldBrowserResponse] = await Promise.all([responseReady, a.page.locator('button[type="submit"]:visible').click()])
      assert.equal(heldBrowserResponse.status(), 200, 'Actual canonical status headers must arrive before fault release')
      assert.ok(/(?:^|,)\s*no-store(?:\s|,|$)/.test(heldBrowserResponse.headers()['cache-control'] ?? ''))
      const held = await bounded(() => fault.waitCommitted(), 'Authentic committed response hold')
      intent = held.intent; receipt = held.receipt
      assert.ok(uuid(intent.clientOperationId)); assert.equal(intent.quoteId, fixture.quoteA); assert.equal(intent.values.notes, submittedNote)
      assert.equal(receipt.code, 'committed'); assert.equal(receipt.owner_id, fixture.ownerA); assert.equal(receipt.quote_id, fixture.quoteA)
      assert.equal(receipt.client_operation_id, intent.clientOperationId); assert.equal(receipt.editor_generation, intent.editorGeneration)
      assert.equal(receipt.before_revision, intent.expectedEditorRevision); assert.notEqual(receipt.after_revision, receipt.before_revision)
      assert.deepEqual(saveBodies, [{ context: 'ownerA', body: intent }])
      assert.equal(receipt.quote.notes, submittedNote)
      for (const [field, value] of Object.entries(exactNumbers)) { assert.equal(Number(intent.values[field]), value); assert.equal(receipt.quote[field], value) }
      const beforeTyping = await assertCopies(a.page, 'pending', submittedNote)
      initialPending = beforeTyping.pending
      assert.deepEqual(await faultEvents(), held.events); assert.equal(observedEvents.length, 4)
      await counts(a.page)
      await a.page.locator('textarea[name="notes"]').fill(newerNote)
      await a.page.waitForFunction(({ key, note }) => {
        try { const draft = JSON.parse(localStorage.getItem(key)); return draft?.value?.notes === note && draft.serialization === JSON.stringify(draft.value) } catch { return false }
      }, { key: draftKey(), note: newerNote })
      await assertCopies(a.page, 'pending', newerNote)
      assert.equal(await a.page.locator('textarea[name="notes"]').inputValue(), newerNote)
      await assertOneWrite()
      report.evidence.push({ kind: 'response-held-newer-draft', clientOperationId: intent.clientOperationId, submittedIntentDigest: digest(intent),
        authenticHeldReceiptDigest: digest(receipt), originalRevision: intent.expectedEditorRevision, originalSubmissionPreserved: true,
        newerTypingDurableBeforeResponseLoss: true, browserResponseHeadersStatus: heldBrowserResponse.status(), receiptDeliveredToEditor: false })
    })
    await check('independent SQL proves normal COMMIT before the authentic response body is dropped', async () => {
      afterSave = await bounded(readIndependentRows, 'Normal-COMMIT SQL read')
      assert.deepEqual(afterSave.ownerB, fixture.before.ownerB); assert.deepEqual(afterSave.denied, fixture.before.denied)
      assert.deepEqual(afterSave.systemUnits, fixture.before.systemUnits)
      for (const [table, rows] of Object.entries(fixture.before.ownerA)) if (!['quotes', 'quote_services'].includes(table)) assert.deepEqual(afterSave.ownerA[table], rows, 'Unintended owner A mutation: ' + table)
      assert.equal(afterSave.ownerA.quotes.length, 1)
      const quote = afterSave.ownerA.quotes[0], services = afterSave.ownerA.quote_services
      assert.equal(quote.id, fixture.quoteA); assert.equal(quote.user_id, fixture.ownerA); assert.equal(quote.notes, submittedNote)
      for (const [field, value] of Object.entries(exactNumbers)) assert.equal(quote[field], value)
      for (const [field, value] of Object.entries(receipt.quote)) assert.deepEqual(comparable(quote[field]), comparable(value), 'Authentic receipt/SQL quote ' + field)
      assert.deepEqual(comparable(services), comparable(receipt.services)); assert.equal(services.length, 3)
      assert.deepEqual(services.map(service => service.sort_order), [0, 1, 2]); assert.equal(new Set(services.map(service => service.id)).size, 3)
      for (let index = 0; index < services.length; index++) {
        assert.equal(services[index].quote_id, fixture.quoteA); assert.equal(services[index].user_id, fixture.ownerA)
        for (const field of ['service_type', 'service_template_id', 'quantity', 'unit', 'unit_price', 'est_minutes', 'discount_type', 'discount_value', 'notes', 'kind']) {
          assert.deepEqual(services[index][field], fixture.before.ownerA.quote_services[index][field], 'Preserved ordered child ' + index + '/' + field)
        }
      }
      await bounded(() => fault.releaseAfterReadback(afterSave), 'Release response failure after independent readback'); released = true
      await drain() // The genuine prefix-only response must finish/fail, never time out while still held.
      assert.equal((await faultEvents()).length, 6)
      report.evidence.push({ kind: 'independent-normal-commit-before-response-drop', beforeDigest: digest(fixture.before), afterDigest: digest(afterSave),
        quoteDigest: digest(quote), orderedServiceIds: services.map(service => service.id), nativeCommitObservedBeforeDrop: true,
        ownerBUnchanged: true, deniedUnchanged: true, newerTypingWasNotSaved: quote.notes !== newerNote })
    })
    await check('actual body failure leaves UNKNOWN and a second Save tap dispatches nothing', async () => {
      await a.page.getByText(unknownMessage, { exact: true }).waitFor({ state: 'visible' })
      await counts(a.page)
      const retained = await assertCopies(a.page, 'unknown', newerNote)
      unknownPendingBytes = retained.copies.pending
      await a.page.locator('button[type="submit"]:visible').click()
      await a.page.getByText(blockedMessage, { exact: true }).waitFor({ state: 'visible' })
      await assertCopies(a.page, 'unknown', newerNote); await assertOneWrite(); await counts(a.page)
      await drain()
      assert.equal(responses.filter(response => response.path === '/api/save').length, 0, 'Browser never receives a decoded Save receipt')
      assert.ok(decodeFailures.some(entry => entry.context === 'ownerA' && entry.path === '/api/save')
        || apiRequestFailures.some(entry => entry.context === 'ownerA' && entry.path === '/api/save'), 'Actual response failure must be observed')
      report.evidence.push({ kind: 'unknown-no-duplicate', pendingBytesDigest: digest(unknownPendingBytes), state: retained.pending.state,
        submittedSerializationDigest: digest(retained.pending.submittedSerialization), currentDraftSerializationDigest: digest(retained.draft.serialization),
        secondSaveTapBlocked: true, browserDecodedSaveReceipts: 0, closeCallbacks: 0, reconciliationCallbacks: 0 })
    })
    await check('explicit recovery and fresh saved-version reads preserve UNKNOWN and the current newer draft', async () => {
      await review(a.page)
      await savedRead(a.page)
      assert.equal(await a.page.locator('textarea[name="notes"]').inputValue(), newerNote)
      const retained = await assertCopies(a.page, 'unknown', newerNote)
      assert.equal(retained.copies.pending, unknownPendingBytes)
      await a.page.getByRole('button', { name: 'Close review', exact: true }).click()
      await a.page.getByRole('button', { name: 'Review recovery', exact: true }).click()
      await a.page.getByText('Earlier Save — outcome not confirmed', { exact: true }).waitFor({ state: 'visible' })
      await assertCopies(a.page, 'unknown', newerNote); await assertOneWrite(); await counts(a.page)
      assert.deepEqual(await bounded(readIndependentRows, 'After recovery SQL read'), afterSave)
      report.evidence.push({ kind: 'explicit-read-not-attribution', currentNotesPreserved: true, savedNoteObservedSeparately: true,
        pendingOriginalRevisionPreserved: true, noPendingRemoval: true, noReconciliationCallback: true })
    })
    await check('reload and fresh same-owner password sign-in retain original recovery without automatic adoption or replay', async () => {
      await a.page.reload({ waitUntil: 'domcontentloaded' })
      await a.page.locator('textarea[name="notes"]').waitFor({ state: 'visible' })
      assert.equal(await a.page.locator('textarea[name="notes"]').inputValue(), submittedNote, 'Reload opens saved baseline, not uncertain/newer local values')
      await review(a.page)
      const reloaded = await assertCopies(a.page, 'unknown', newerNote)
      assert.equal(reloaded.copies.pending, unknownPendingBytes); preservedDraftBytes = reloaded.copies.draft
      const tokenPostsBefore = report.requests.filter(request => request.context === 'ownerA' && request.path === '/auth/v1/token' && request.method === 'POST').length
      const previousCookieDigest = await authCookieDigest(a.context)
      await signIn(a.page, fixture.emailA, fixture.quoteA)
      await a.page.locator('textarea[name="notes"]').waitFor({ state: 'visible' })
      assert.equal(report.requests.filter(request => request.context === 'ownerA' && request.path === '/auth/v1/token' && request.method === 'POST').length, tokenPostsBefore + 1,
        'Fresh password sign-in must make one genuine Auth request')
      assert.notEqual(await authCookieDigest(a.context), previousCookieDigest, 'Fresh credential sign-in must replace the actual Auth cookie bytes')
      assert.equal(await a.page.locator('textarea[name="notes"]').inputValue(), submittedNote)
      await review(a.page); await savedRead(a.page)
      await assertCopies(a.page, 'unknown', newerNote, true)
      const pendingDraft = a.page.locator('article').filter({ has: a.page.getByText('This draft belongs to an earlier Save. It is available for review without retrying.', { exact: true }) })
      assert.equal(await pendingDraft.count(), 1)
      assert.equal(await pendingDraft.getByRole('button', { name: 'Continue this draft', exact: true }).isEnabled(), false, 'Pending original draft cannot be adopted/rebased')
      await a.page.locator('button[type="submit"]:visible').click()
      await a.page.getByText(blockedMessage, { exact: true }).waitFor({ state: 'visible' })
      await assertCopies(a.page, 'unknown', newerNote, true); await assertOneWrite(); await counts(a.page)
      report.evidence.push({ kind: 'same-storage-fresh-auth-recovery', sameBrowserContext: true, actualPasswordSignInObserved: true,
        authCookieBytesChanged: true, pendingBytesUnchanged: true, originalDraftBytesUnchanged: true, openedSavedBaseline: true, uncertainDraftNotAdopted: true, secondWriteBlocked: true })
    })
    await check('an independent fresh Auth session reads saved facts without turning them into an acknowledgement', async () => {
      const fresh = await bounded(readFreshOwnerRows, 'Fresh authenticated PostgREST read')
      assert.equal(fresh.ownerId, fixture.ownerA); assert.deepEqual(comparable(fresh.quote), comparable(afterSave.ownerA.quotes[0]))
      assert.deepEqual(comparable(fresh.services), comparable(afterSave.ownerA.quote_services))
      await assertCopies(a.page, 'unknown', newerNote, true); await counts(a.page); await assertOneWrite()
      report.evidence.push({ kind: 'fresh-auth-current-facts-only', ownerId: fresh.ownerId, quoteDigest: digest(fresh.quote), servicesDigest: digest(fresh.services),
        matchesIndependentSql: true, browserSessionReused: false, productAttributionClaimed: false, pendingStillUnknown: true })
    })
    await check('real owner B cannot read owner A baseline and all committed rows remain unchanged', async () => {
      const b = await newPage('ownerB'); await signIn(b.page, fixture.emailB, fixture.quoteA)
      await b.page.getByText('This quote is unavailable for your account.', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await b.page.locator('input[name="initial_price"]').count(), 0)
      await baselineRefusal(b.page, fixture.quoteA, 404, 'not_found'); await counts(b.page)
      assert.deepEqual(await bounded(readIndependentRows, 'Owner B refusal SQL read'), afterSave)
      report.evidence.push({ kind: 'foreign-baseline-refused', status: 404, allCapturedRowsUnchanged: true })
    })
    await check('real denied account cannot read its own quote without owner standing', async () => {
      const denied = await newPage('denied'); await signIn(denied.page, fixture.deniedEmail, fixture.quoteDenied)
      await denied.page.getByText('This editor requires a verified business owner.', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await denied.page.locator('input[name="initial_price"]').count(), 0)
      await baselineRefusal(denied.page, fixture.quoteDenied, 403, 'forbidden'); await counts(denied.page)
      assert.deepEqual(await bounded(readIndependentRows, 'Denied refusal SQL read'), afterSave)
      report.evidence.push({ kind: 'denied-own-baseline-refused', status: 403, allCapturedRowsUnchanged: true })
    })
    await check('an anonymous browser cannot read the quote and all committed rows remain unchanged', async () => {
      const anonymous = await newPage('unauthenticated')
      await anonymous.page.goto(baseURL + '/quote?quoteId=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
      await anonymous.page.getByText('Sign in to verify your quote data.', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await anonymous.page.locator('input[name="initial_price"]').count(), 0)
      assert.equal((await anonymous.context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).length, 0)
      await baselineRefusal(anonymous.page, fixture.quoteA, 401, 'unauthenticated')
      assert.deepEqual(await bounded(readIndependentRows, 'Anonymous refusal SQL read'), afterSave)
      report.evidence.push({ kind: 'anonymous-baseline-refused', status: 401, allCapturedRowsUnchanged: true })
    })
    await check('the complete observed flow contains one Save and one native dispatch with no acknowledgement, replay or unexpected browser IO', async () => {
      await drain(); await assertOneWrite(); await counts(a.page); await assertCopies(a.page, 'unknown', newerNote, true)
      assert.deepEqual(report.failures, []); assert.equal(observedEvents.length, 6)
      assert.equal(responses.filter(response => response.path === '/api/save').length, 0)
      assert.ok(decodeFailures.length + apiRequestFailures.length > 0)
      for (const failed of [...decodeFailures, ...apiRequestFailures]) assert.deepEqual(failed, { context: 'ownerA', path: '/api/save' }, 'Only the deliberately lost Save response may fail')
      for (const request of report.requests) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) continue
        assert.ok(request.method === 'POST' && (request.origin === baseURL && ['/api/baseline', '/api/save'].includes(request.path)
          || request.origin === 'http://127.0.0.1:8000' && ['/auth/v1/token', '/rest/v1/rpc/current_app_role'].includes(request.path)),
        'Unexpected browser mutation/capability: ' + request.method + ' ' + request.path)
      }
      assert.deepEqual(await bounded(readIndependentRows, 'Final invariant SQL read'), afterSave)
      report.evidence.push({ kind: 'complete-io-boundary', browserSaveRequests: 1, nativeCommitDispatches: 1, nativeCommitReturns: 1,
        decodedBrowserSaveReceipts: 0, retainedPending: true, faultEvents: observedEvents, allCapturedRowsUnchangedAfterCommit: true })
    })
    report.pass = report.tests.length === 11 && report.tests.every(test => test.pass)
  } catch (error) { report.error = { phase, message: safeError(error) }; report.pass = false }
  finally {
    // Close owned contexts first, so a failure before the release barrier cannot
    // leave response observers waiting on a live browser. Root still owns and
    // must close the held server response/fault, even on an early failed case.
    for (const { context, entry } of contexts.reverse()) {
      try { await bounded(() => context.close(), 'Owned browser context closure', 20_000); entry.closed = true }
      catch { report.failures.push({ kind: 'context-close', context: entry.name }) }
    }
    await drain()
    report.allContextsClosed = report.contexts.every(entry => entry.opened && entry.closed)
    report.allOpenedContextsClosed = report.contexts.filter(entry => entry.opened).every(entry => entry.closed)
    report.responseSummary = responses.map(response => ({ context: response.context, path: response.path, status: response.status, code: response.body?.code, noStore: response.noStore }))
    report.responseFailures = { bodyDecode: decodeFailures, requests: apiRequestFailures }
    report.fault = { responseReleaseRequestedAfterReadback: released, events: observedEvents, teardownOwnedByCaller: true }
    report.pass = report.pass && report.contexts.length === 4 && report.allContextsClosed && report.failures.length === 0
  }
  return report
}
