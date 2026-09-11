import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

// Actual Playwright Browser supplied by the isolated cloud driver. This module
// owns its contexts only. No request interception, synthetic SDK/session, page
// handler replacement, calculated quote engine, or fabricated acknowledgement.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const isLoopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host)
const note = 'Scope saved by the real authenticated browser'
const exactNumbers = Object.freeze({ initial_price: 101.23, hours: 1.13, rate: 37.17, measured_sqft: 1234.56 })

// PostgREST and to_jsonb may spell the SAME native timestamp with Z or +00:00.
// Normalize only offset spelling; do not Date-parse/truncate PG microseconds,
// sort children, coerce numbers, or reconstruct native generated amounts.
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, comparable(v)]))
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) {
    return value.replace(/(?:Z|\+00:00)$/, '+00:00').replace(/(\.\d*?[1-9])0+(?=\+)/, '$1').replace(/\.0+(?=\+)/, '')
  }
  return value
}

/**
 * readIndependentRows(): fresh independent SQL readFixture(sql, fixture).
 * readFreshOwnerRows(): a NEW real signInWithPassword session, actual getUser,
 * and PostgREST SELECT * quote plus services ORDER BY sort_order,id; returns
 * {ownerId,quote,services}. It must not reuse the browser token or this receipt.
 * Neither capability is supplied a desired/expected row or mutation plan.
 */
export async function runAuthenticatedQuoteSaveBrowser({ browser, baseURL, fixture, readIndependentRows, readFreshOwnerRows }) {
  const report = { pass: false, tests: [], evidence: [], requests: [], failures: [],
    scope: 'Actual generated Next mount, canonical Supabase cookie/browser clients, Auth, PostgREST, full OwnerEditor and a normally committed Save. Synthetic fixture accounts only.',
    contexts: [], allContextsClosed: false, browserOwnedByCaller: true,
    limits: ['Driver owns actual platform/process provenance and closure.', 'Minimal visibility CSS; no production layout or visual parity claim.',
      'Only one normal Save; lost acknowledgement and acceptance ordering are separate gates.',
      'SQL unchanged-row assertions cover the fixture readback inventory, not every table in the database.'] }
  const contexts = [], responses = [], responseTasks = [], requestMap = new WeakMap()
  let phase = 'validate isolated harness', capturedIntent, committedReceipt, afterSave
  const safeError = error => String(error instanceof Error ? error.message : 'Unknown browser failure')
    .replaceAll(String(fixture?.password ?? '__no_password__'), '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]').slice(0, 1000)
  const check = async (name, work) => {
    phase = name
    try { await work(); report.tests.push({ name, pass: true }) }
    catch (error) { report.tests.push({ name, pass: false, error: safeError(error) }); throw error }
  }
  const drainResponses = async () => { let count; do { count = responseTasks.length; await Promise.all(responseTasks) } while (count !== responseTasks.length) }
  const inspectURL = raw => {
    const url = new URL(raw)
    const transportOrigin = url.origin.replace(/^ws:/, 'http:')
    assert.ok(['http:', 'ws:'].includes(url.protocol)
      && [baseURL, 'http://127.0.0.1:8000'].includes(transportOrigin), 'Browser observed an unexpected origin')
    return url
  }
  const newPage = async label => {
    const entry = { name: label, attempted: true, opened: false, closed: false }
    report.contexts.push(entry)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' })
    contexts.push({ context, entry }); entry.opened = true
    context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(45_000)
    await context.addInitScript(() => {
      window.__authQuoteNativeEvents = { submitted: 0, invalid: [] }
      document.addEventListener('submit', event => {
        if (event.target instanceof HTMLFormElement && event.target.querySelector('input[name="initial_price"]')) window.__authQuoteNativeEvents.submitted++
      }, true)
      document.addEventListener('invalid', event => {
        if (event.target instanceof HTMLInputElement && event.target.form?.querySelector('input[name="initial_price"]')) window.__authQuoteNativeEvents.invalid.push(event.target.name)
      }, true)
    })
    context.on('request', request => {
      try {
        const url = inspectURL(request.url()), entry = { context: label, method: request.method(), origin: url.origin, path: url.pathname }
        report.requests.push(entry); requestMap.set(request, entry)
      } catch (error) { report.failures.push({ kind: 'request-boundary', error: safeError(error) }) }
    })
    context.on('response', response => {
      const request = response.request(), entry = requestMap.get(request)
      if (entry) entry.status = response.status()
      const url = new URL(response.url())
      if (url.origin !== baseURL || !['/api/baseline', '/api/save'].includes(url.pathname)) return
      const task = (async () => {
        let timer
        try {
          const body = await Promise.race([response.json(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('API response body timeout')), 20_000) })])
          responses.push({ context: label, path: url.pathname, status: response.status(), body,
          request: request.postDataJSON(), noStore: /(?:^|,)\s*no-store(?:\s|,|$)/.test(response.headers()['cache-control'] ?? '') }) }
        catch { report.failures.push({ kind: 'api-response-decode', context: label, path: url.pathname }) }
        finally { clearTimeout(timer) }
      })()
      responseTasks.push(task)
    })
    const page = await context.newPage()
    page.on('pageerror', error => report.failures.push({ kind: 'page-error', context: label, error: safeError(error) }))
    page.on('websocket', socket => { try { inspectURL(socket.url()) } catch (error) { report.failures.push({ kind: 'websocket-boundary', error: safeError(error) }) } })
    return { page, context }
  }
  const signIn = async (page, email, quoteId) => {
    await page.goto(baseURL + '/login?quoteId=' + quoteId, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-testid="login-ready"]')?.textContent === 'ready')
    assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true)
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(fixture.password)
    await Promise.all([
      page.waitForURL(url => url.origin === baseURL && url.pathname === '/quote' && url.searchParams.get('quoteId') === quoteId),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ])
  }
  const counts = async page => {
    assert.equal((await page.getByTestId('closed-count').textContent())?.trim(), '0', 'No unsolicited close callback')
    assert.equal((await page.getByTestId('reconciliation-count').textContent())?.trim(), '0', 'Normal Save must not reconcile or replay')
  }
  const post = (page, path, body) => page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json(), noStore: response.headers.get('cache-control') === 'no-store' }
  }, { path, body })
  const refusal = async (page, target, status, code) => {
    for (const [path, body] of [['/api/baseline', { version: 1, quoteId: target }],
      ['/api/save', { ...capturedIntent, quoteId: target, clientOperationId: randomUUID() }]]) {
      const result = await post(page, path, body)
      assert.equal(result.status, status); assert.deepEqual(result.body, { code }); assert.equal(result.noStore, true)
    }
  }
  try {
    assert.equal(baseURL, 'http://127.0.0.1:3000', 'Only the reviewed isolated application origin is permitted')
    const origin = new URL(baseURL)
    assert.equal(origin.origin, baseURL); assert.equal(origin.protocol, 'http:'); assert.ok(isLoopback(origin.hostname))
    assert.equal(browser.browserType().name(), 'chromium'); assert.equal(browser.isConnected(), true)
    assert.equal(typeof readIndependentRows, 'function'); assert.equal(typeof readFreshOwnerRows, 'function')
    for (const key of ['ownerA', 'ownerB', 'denied', 'quoteA', 'quoteB', 'quoteDenied']) assert.ok(uuid(fixture[key]), 'Fixture UUID ' + key)
    assert.equal(new Set([fixture.ownerA, fixture.ownerB, fixture.denied]).size, 3)
    assert.ok(fixture.before && fixture.before.ownerA && fixture.before.ownerB && fixture.before.denied)
    report.browserVersion = browser.version()
    const a = await newPage('ownerA')
    await check('real owner A signs in and the canonical verified editor loads its native baseline', async () => {
      await signIn(a.page, fixture.emailA, fixture.quoteA)
      await a.page.locator('input[name="initial_price"]').waitFor({ state: 'visible' })
      await a.page.getByRole('region', { name: 'Quote editor', exact: true }).waitFor({ state: 'visible' })
      await drainResponses()
      const baselines = responses.filter(r => r.context === 'ownerA' && r.path === '/api/baseline' && r.status === 200)
      assert.ok(baselines.length > 0)
      for (const r of baselines) { assert.equal(r.body.code, 'baseline'); assert.equal(r.body.ownerId, fixture.ownerA); assert.equal(r.body.quoteId, fixture.quoteA); assert.equal(r.noStore, true) }
      assert.ok((await a.context.cookies()).some(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)), 'Real canonical Auth cookie required')
      assert.deepEqual(await readIndependentRows(), fixture.before, 'Login and auxiliary/baseline reads must not mutate fixture business rows')
      await counts(a.page)
      report.evidence.push({ kind: 'real-owner-baseline', ownerId: fixture.ownerA, quoteId: fixture.quoteA, baselineCount: baselines.length,
        baselineDigest: digest(baselines.at(-1).body), actualCookiePresent: true, businessRowsUnchanged: true })
    })
    await check('all four exact decimal controls are visible and pass native validation after actual typing', async () => {
      const pricing = a.page.getByRole('button', { name: /^Pricing help(?:\s|$)/ })
      if (await pricing.getAttribute('aria-expanded') !== 'true') await pricing.click()
      const fields = []
      for (const [name, value] of Object.entries(exactNumbers)) {
        const input = a.page.locator('input[name="' + name + '"]')
        await input.waitFor({ state: 'visible' }); assert.equal(await input.inputValue(), String(value))
        await input.fill(String(value)); await input.blur()
        const state = await input.evaluate(node => ({ value: node.value, valueAsNumber: node.valueAsNumber, type: node.type, step: node.step,
          min: node.min, valid: node.checkValidity(), stepMismatch: node.validity.stepMismatch, disabled: node.disabled, readOnly: node.readOnly }))
        assert.equal(state.value, String(value)); assert.equal(state.valueAsNumber, value); assert.equal(state.type, 'number')
        assert.equal(state.step, 'any'); assert.equal(state.min, '0'); assert.equal(state.valid, true); assert.equal(state.stepMismatch, false)
        assert.equal(state.disabled, false); assert.equal(state.readOnly, false); fields.push({ name, ...state })
      }
      await a.page.locator('textarea[name="notes"]').fill(note)
      const form = a.page.locator('form').filter({ has: a.page.locator('input[name="initial_price"]') })
      assert.equal(await form.evaluate(node => node.noValidate), false)
      assert.equal(await form.evaluate(node => node.checkValidity()), true, 'The actual complete form must be natively valid')
      report.evidence.push({ kind: 'actual-native-control-validity', fields, formNoValidate: false })
    })
    await check('one native form submit receives the real committed receipt and the actual editor acknowledges it', async () => {
      assert.equal(await a.page.locator('button[type="submit"]:visible').evaluate(node => node.formNoValidate), false)
      const [response] = await Promise.all([
        a.page.waitForResponse(r => new URL(r.url()).origin === baseURL && new URL(r.url()).pathname === '/api/save' && r.request().method() === 'POST'),
        a.page.locator('button[type="submit"]:visible').click(),
      ])
      capturedIntent = response.request().postDataJSON(); committedReceipt = await response.json()
      assert.equal(response.status(), 200); assert.equal(committedReceipt.code, 'committed')
      assert.equal(capturedIntent.quoteId, fixture.quoteA); assert.equal(committedReceipt.owner_id, fixture.ownerA); assert.equal(committedReceipt.quote_id, fixture.quoteA)
      assert.equal(committedReceipt.client_operation_id, capturedIntent.clientOperationId)
      assert.equal(committedReceipt.editor_generation, capturedIntent.editorGeneration)
      assert.equal(committedReceipt.before_revision, capturedIntent.expectedEditorRevision)
      assert.notEqual(committedReceipt.after_revision, committedReceipt.before_revision)
      for (const [name, value] of Object.entries(exactNumbers)) { assert.equal(Number(capturedIntent.values[name]), value); assert.equal(committedReceipt.quote[name], value) }
      assert.equal(capturedIntent.values.notes, note); assert.equal(committedReceipt.quote.notes, note)
      await a.page.getByText('Submitted version saved', { exact: true }).waitFor({ state: 'visible' })
      await counts(a.page); await drainResponses()
      const saves = responses.filter(r => r.context === 'ownerA' && r.path === '/api/save')
      assert.equal(saves.length, 1); assert.equal(saves[0].noStore, true)
      const events = await a.page.evaluate(() => window.__authQuoteNativeEvents)
      assert.deepEqual(events, { submitted: 1, invalid: [] })
      report.evidence.push({ kind: 'normal-committed-save', clientOperationId: capturedIntent.clientOperationId, submittedIntentDigest: digest(capturedIntent),
        receiptDigest: digest(committedReceipt), beforeRevision: committedReceipt.before_revision, afterRevision: committedReceipt.after_revision,
        nativeSubmitEvents: events, successfulHttpSaves: 1, acknowledgementUiObserved: true, closeCallbacks: 0, reconciliationCallbacks: 0 })
    })
    await check('independent committed SQL readback preserves precision, ordered child content and other tenants', async () => {
      afterSave = await readIndependentRows()
      assert.deepEqual(afterSave.ownerB, fixture.before.ownerB); assert.deepEqual(afterSave.denied, fixture.before.denied)
      assert.deepEqual(afterSave.systemUnits, fixture.before.systemUnits)
      for (const [table, rows] of Object.entries(fixture.before.ownerA)) if (!['quotes', 'quote_services'].includes(table)) assert.deepEqual(afterSave.ownerA[table], rows, 'Unintended owner A table mutation: ' + table)
      assert.equal(afterSave.ownerA.quotes.length, 1)
      const quote = afterSave.ownerA.quotes[0]
      assert.equal(quote.id, fixture.quoteA); assert.equal(quote.user_id, fixture.ownerA); assert.equal(quote.notes, note)
      for (const [name, value] of Object.entries(exactNumbers)) assert.equal(quote[name], value)
      for (const field of ['customer_id', 'property_id', 'quote_number', 'status', 'selected_option_id', 'accepted_price', 'internal_notes', 'measurement_snapshot']) {
        assert.deepEqual(quote[field], fixture.before.ownerA.quotes[0][field], 'Preserved quote field: ' + field)
      }
      const services = afterSave.ownerA.quote_services
      assert.equal(services.length, 3); assert.equal(new Set(services.map(row => row.id)).size, 3)
      assert.deepEqual(services.map(row => row.sort_order), [0, 1, 2])
      const source = fixture.before.ownerA.quote_services
      for (let i = 0; i < services.length; i++) {
        assert.ok(uuid(services[i].id)); assert.equal(services[i].quote_id, fixture.quoteA); assert.equal(services[i].user_id, fixture.ownerA)
        for (const field of ['service_type', 'service_template_id', 'quantity', 'unit', 'unit_price', 'est_minutes', 'discount_type', 'discount_value', 'notes', 'kind']) {
          assert.deepEqual(services[i][field], source[i][field], 'Native ordered child content ' + i + '/' + field)
        }
      }
      for (const [field, value] of Object.entries(committedReceipt.quote)) assert.deepEqual(comparable(quote[field]), comparable(value), 'Native receipt vs SQL quote ' + field)
      assert.deepEqual(comparable(services), comparable(committedReceipt.services))
      report.evidence.push({ kind: 'independent-committed-sql', beforeDigest: digest(fixture.before), afterDigest: digest(afterSave),
        observedNumbers: Object.fromEntries(Object.keys(exactNumbers).map(field => [field, quote[field]])),
        observedQuoteId: quote.id, observedPublicNote: quote.notes,
        orderedServiceIds: services.map(row => row.id), ownerBUnchanged: true, deniedUnchanged: true,
        unchangedOwnerATables: Object.keys(fixture.before.ownerA).filter(table => !['quotes', 'quote_services'].includes(table)) })
    })
    await check('a fresh real owner A session reads the same committed quote and ordered children through PostgREST', async () => {
      const fresh = await readFreshOwnerRows()
      assert.equal(fresh.ownerId, fixture.ownerA)
      assert.deepEqual(comparable(fresh.quote), comparable(afterSave.ownerA.quotes[0]))
      assert.deepEqual(comparable(fresh.services), comparable(afterSave.ownerA.quote_services))
      report.evidence.push({ kind: 'fresh-auth-postgrest-readback', ownerId: fresh.ownerId, quoteDigest: digest(fresh.quote), servicesDigest: digest(fresh.services),
        observedNumbers: Object.fromEntries(Object.keys(exactNumbers).map(field => [field, fresh.quote[field]])),
        observedQuoteId: fresh.quote.id, orderedServiceIds: fresh.services.map(row => row.id),
        matchesIndependentSql: true, browserSessionReused: false, orderNormalizedByTest: false })
    })
    await check('real owner B cannot open or save owner A quote and all committed rows stay unchanged', async () => {
      const b = await newPage('ownerB'); await signIn(b.page, fixture.emailB, fixture.quoteA)
      await b.page.getByText('This quote is unavailable for your account.', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await b.page.locator('input[name="initial_price"]').count(), 0)
      await refusal(b.page, fixture.quoteA, 404, 'not_found')
      assert.deepEqual(await readIndependentRows(), afterSave); await counts(b.page)
      report.evidence.push({ kind: 'ownerB-refused', baselineStatus: 404, saveStatus: 404, target: fixture.quoteA, allCapturedRowsUnchanged: true })
    })
    await check('real denied account cannot open or save its own quote without owner standing', async () => {
      const denied = await newPage('denied'); await signIn(denied.page, fixture.deniedEmail, fixture.quoteDenied)
      await denied.page.getByText('This editor requires a verified business owner.', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await denied.page.locator('input[name="initial_price"]').count(), 0)
      await refusal(denied.page, fixture.quoteDenied, 403, 'forbidden')
      assert.deepEqual(await readIndependentRows(), afterSave); await counts(denied.page)
      report.evidence.push({ kind: 'denied-own-quote-refused', baselineStatus: 403, saveStatus: 403, ownQuote: fixture.quoteDenied, allCapturedRowsUnchanged: true })
    })
    await check('a fresh unauthenticated browser cannot read or save the quote', async () => {
      const anonymous = await newPage('unauthenticated')
      await anonymous.page.goto(baseURL + '/quote?quoteId=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
      assert.match(await anonymous.page.locator('body').innerText(), /sign in/i)
      assert.equal(await anonymous.page.locator('input[name="initial_price"]').count(), 0)
      assert.equal((await anonymous.context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).length, 0)
      await refusal(anonymous.page, fixture.quoteA, 401, 'unauthenticated')
      assert.deepEqual(await readIndependentRows(), afterSave)
      report.evidence.push({ kind: 'unauthenticated-refused', baselineStatus: 401, saveStatus: 401, allCapturedRowsUnchanged: true })
    })
    await check('observed browser IO contains exactly one successful Save and no provider or legacy writes', async () => {
      await drainResponses()
      assert.deepEqual(report.failures, [])
      const saves = responses.filter(r => r.path === '/api/save')
      assert.deepEqual(saves.map(r => [r.context, r.status, r.body.code]), [
        ['ownerA', 200, 'committed'], ['ownerB', 404, 'not_found'], ['denied', 403, 'forbidden'], ['unauthenticated', 401, 'unauthenticated'],
      ])
      for (const request of report.requests) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) continue
        const permitted = request.method === 'POST' && (
          request.origin === baseURL && ['/api/baseline', '/api/save'].includes(request.path)
          || request.origin !== baseURL && ['/auth/v1/token', '/rest/v1/rpc/current_app_role'].includes(request.path))
        assert.ok(permitted, 'Unexpected browser mutation/capability: ' + request.method + ' ' + request.path)
      }
      await counts(a.page)
    })
    report.pass = report.tests.length === 9 && report.tests.every(test => test.pass)
  } catch (error) {
    report.error = { phase, message: safeError(error) }; report.pass = false
  } finally {
    await drainResponses()
    for (const { context, entry } of contexts.reverse()) {
      try { await context.close(); entry.closed = true }
      catch { report.failures.push({ kind: 'context-close', context: entry.name }) }
    }
    report.allContextsClosed = report.contexts.every(entry => entry.opened && entry.closed)
    report.pass = report.pass && report.allContextsClosed && report.failures.length === 0
    report.responseSummary = responses.map(r => ({ context: r.context, path: r.path, status: r.status, code: r.body?.code, noStore: r.noStore }))
  }
  return report
}
