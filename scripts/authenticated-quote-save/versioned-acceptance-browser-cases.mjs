import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Isolated proof only. Acceptance uses browser POSTs to the actual HTTP adapters,
// not a replacement consent UI. Only the owner Save uses the mounted real editor.
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha(JSON.stringify(value))
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const noteV2 = 'Public scope V2 saved before a fresh customer acceptance'
const acceptancePaths = ['/api/acceptance/preview', '/api/acceptance/commit']
const termsText = 'Payment is due after the completed visit.'
const sourceRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
let canonicalBundle

async function loadCanonicalWire() {
  canonicalBundle ??= (async () => {
    const req = createRequire(join(sourceRoot, 'package.json')), { build, version } = req('esbuild')
    const consumed = new Map()
    const pathInfo = path => {
      const actual = realpathSync(path), local = relative(sourceRoot, actual).replaceAll('\\', '/')
      assert.ok(local && !isAbsolute(local) && local !== '..' && !local.startsWith('../'), 'Canonical bundle input must stay in the checked-out source/dependencies')
      return { actual, path: local, kind: local.startsWith('node_modules/') ? 'dependency' : 'source' }
    }
    const generated = "export { parsePilotAcceptancePreview, buildPilotAcceptanceCommitRequest, parsePilotAcceptanceCommitReply } from './src/lib/quotes/pilotQuoteAcceptance.ts';\nexport { termsClaimPatch } from './src/lib/payments/termsTimingConflict.ts';\nexport { parsePilotQuoteSaveReceipt } from './src/lib/quotes/pilotQuoteSaveReceipt.ts';\n"
    const result = await build({ absWorkingDir: sourceRoot, stdin: { contents: generated, resolveDir: sourceRoot, sourcefile: 'versioned-acceptance-proof-entry.ts', loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true, logLevel: 'silent',
      tsconfig: join(sourceRoot, 'tsconfig.json'), plugins: [{ name: 'capture-exact-canonical-proof-inputs', setup(builder) {
        builder.onLoad({ filter: /\.(?:[cm]?js|jsx|ts|tsx|json)$/ }, args => {
          const item = pathInfo(args.path), bytes = readFileSync(item.actual)
          consumed.set(item.path, { path: item.path, kind: item.kind, sha256: sha(bytes), bytes: bytes.length })
          const extension = extname(item.actual).slice(1)
          return { contents: bytes, loader: ['mjs', 'cjs'].includes(extension) ? 'js' : extension, resolveDir: dirname(item.actual) }
        })
      } }] })
    assert.equal(result.outputFiles.length, 1)
    for (const output of Object.values(result.metafile.outputs)) assert.deepEqual(output.imports, [], 'Canonical proof bundle may not defer unpinned runtime imports')
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input === 'versioned-acceptance-proof-entry.ts' || input === '<stdin>') continue
      const item = pathInfo(resolve(sourceRoot, input)); assert.ok(consumed.has(item.path), 'Every transitive consumed input must have captured bytes')
    }
    const configuration = ['tsconfig.json', 'package.json', 'package-lock.json'].map(path => {
      const item = pathInfo(join(sourceRoot, path)), bytes = readFileSync(item.actual)
      return { path, sha256: sha(bytes), bytes: bytes.length }
    })
    const bytes = result.outputFiles[0].contents
    const wire = await import('data:text/javascript;base64,' + Buffer.from(bytes).toString('base64'))
    for (const key of ['parsePilotAcceptancePreview', 'buildPilotAcceptanceCommitRequest', 'parsePilotAcceptanceCommitReply', 'termsClaimPatch', 'parsePilotQuoteSaveReceipt']) assert.equal(typeof wire[key], 'function')
    return { wire, evidence: { kind: 'actual-canonical-wire-bundle', esbuildVersion: version, generatedEntrySha256: sha(generated),
      bundleSha256: sha(bytes), bundleBytes: bytes.length, consumedInputs: [...consumed.values()].sort((a, b) => a.path.localeCompare(b.path)), configuration,
      scope: 'Actual TS source and captured dependency bytes compiled in memory; no source policy replacement. Dependency provenance remains the root lock/install gate.' } }
  })()
  return canonicalBundle
}

/** Seed helper uses the SAME actual canonical classifier, not a synthetic claim. */
export const loadAcceptanceProofWire = loadCanonicalWire
export async function acceptanceFixtureTerms() {
  const { wire } = await loadCanonicalWire()
  return { termsText, patch: wire.termsClaimPatch(termsText) }
}

function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, comparable(child)]))
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) {
    return value.replace(/(?:Z|\+00:00)$/, '+00:00').replace(/(\.\d*?[1-9])0+(?=\+)/, '$1').replace(/\.0+(?=\+)/, '')
  }
  return value
}
async function bounded(work, label, ms = 60_000) {
  let timer
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms) })]) }
  finally { clearTimeout(timer) }
}

/** readNativeAcceptanceFacts is a fresh independent SQL SELECT of actual
 * quote_material_fingerprint(quoteA), quote_terms_fingerprint(ownerA), and
 * quote_acceptance_is_current(quoteA). Never derive these facts in JavaScript. */
export async function runVersionedAcceptanceBrowser({ browser, baseURL, fixture, readIndependentRows, readFreshOwnerRows, readNativeAcceptanceFacts }) {
  const report = { pass: false, tests: [], evidence: [], requests: [], failures: [], contexts: [], allContextsClosed: false,
    allOpenedContextsClosed: false, browserOwnedByCaller: true,
    scope: 'Sequential real owner Save UI and token-authorized portal HTTP/native acceptance: old preview refusal followed by explicit fresh preview and normal accepted COMMIT.',
    limits: ['No acceptance UI, concurrency, owner-on-behalf, lost acknowledgement or attributable recovery claim.',
      'Root owns disposable platform/proposal application, actual Auth/PostgREST and Browser/process closure.',
      'Independent unchanged-row checks cover the declared fixture inventory, not every database table.',
      'Browser requests use genuine canonical responses without interception; portal tokens stay in private POST bodies only.'] }
  const secrets = [fixture?.password, fixture?.portalTokenA, fixture?.portalTokenB, fixture?.revokedPortalTokenA].filter(value => typeof value === 'string' && value.length > 0)
  const safeError = error => {
    let value = String(error instanceof Error ? error.message : 'Unknown proof failure')
    for (const secret of secrets) value = value.replaceAll(secret, '[redacted]')
    return value.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-token]').slice(0, 1000)
  }
  const contexts = [], responses = [], tasks = [], saveRequests = [], portalCalls = [], requestMap = new WeakMap()
  let phase = 'validate disposable harness', wire, previewV1, previewV2, oldIntent, newIntent, saveIntent, saveReceipt, acceptedReply, afterSave, afterAccepted, initialFacts, savedFacts
  const check = async (name, work) => {
    phase = name
    try { await work(); report.tests.push({ name, pass: true }) }
    catch (error) { report.tests.push({ name, pass: false, error: safeError(error) }); throw error }
  }
  const inspectURL = raw => {
    for (const secret of secrets) assert.equal(raw.includes(secret), false, 'A private credential appeared in a URL')
    const url = new URL(raw), origin = url.origin.replace(/^ws:/, 'http:')
    assert.ok(['http:', 'ws:'].includes(url.protocol) && [baseURL, 'http://127.0.0.1:8000'].includes(origin), 'Unexpected browser origin')
    return url
  }
  const newPage = async label => {
    const entry = { name: label, attempted: true, opened: false, closed: false }; report.contexts.push(entry)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block' })
    contexts.push({ context, entry }); entry.opened = true; context.setDefaultTimeout(20_000); context.setDefaultNavigationTimeout(45_000)
    context.on('request', request => {
      try {
        const url = inspectURL(request.url()), entry = { context: label, method: request.method(), origin: url.origin, path: url.pathname }
        report.requests.push(entry); requestMap.set(request, entry)
        // Inspect only the synthetic owner Save. Never store portal/Auth bodies.
        if (url.origin === baseURL && url.pathname === '/api/save') saveRequests.push({ context: label, body: request.postDataJSON() })
      } catch (error) { report.failures.push({ kind: 'request-boundary', error: safeError(error) }) }
    })
    context.on('response', response => {
      const entry = requestMap.get(response.request()); if (entry) entry.status = response.status()
      const url = new URL(response.url())
      if (url.origin !== baseURL || !['/api/baseline', '/api/save', ...acceptancePaths].includes(url.pathname)) return
      tasks.push((async () => {
        try {
          const body = await bounded(() => response.json(), 'Observed actual API response', 20_000)
          const serialized = JSON.stringify(body)
          for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'API response exposed a private credential')
          responses.push({ context: label, path: url.pathname, status: response.status(), body,
            noStore: /(?:^|,)\s*no-store(?:\s|,|$)/.test(response.headers()['cache-control'] ?? '') })
        } catch (error) { report.failures.push({ kind: 'api-response', context: label, path: url.pathname, error: safeError(error) }) }
      })())
    })
    context.on('requestfailed', request => {
      const entry = requestMap.get(request)
      if (entry?.origin === baseURL && ['/api/baseline', '/api/save', ...acceptancePaths].includes(entry.path)) report.failures.push({ kind: 'api-request-failed', context: label, path: entry.path })
    })
    const page = await context.newPage()
    page.on('pageerror', error => report.failures.push({ kind: 'page-error', context: label, error: safeError(error) }))
    page.on('websocket', socket => { try { inspectURL(socket.url()) } catch (error) { report.failures.push({ kind: 'websocket-boundary', error: safeError(error) }) } })
    return { context, page }
  }
  const drain = async () => { let count; do { count = tasks.length; await Promise.all(tasks) } while (count !== tasks.length) }
  const counts = async page => {
    assert.equal((await page.getByTestId('closed-count').textContent())?.trim(), '0')
    assert.equal((await page.getByTestId('reconciliation-count').textContent())?.trim(), '0', 'No read may manufacture acknowledgement')
  }
  const portalPost = async (page, path, body, label) => {
    assert.ok(acceptancePaths.includes(path)); assert.ok(Object.hasOwn(body, 'portalToken'), 'This proof never invokes owner-on-behalf acceptance')
    assert.ok([fixture.portalTokenA, fixture.portalTokenB, fixture.revokedPortalTokenA].includes(body.portalToken))
    const result = await page.evaluate(async ({ path, body }) => {
      const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json(), noStore: response.headers.get('cache-control') === 'no-store' }
    }, { path, body })
    assert.equal(result.noStore, true)
    portalCalls.push({ label, path, status: result.status, code: result.body?.code,
      ...(body.clientOperationId ? { clientOperationId: body.clientOperationId, previewRevision: body.expected.previewRevision } : {}) })
    return result
  }
  const unchangedOutside = (before, after, allowed) => {
    assert.deepEqual(after.ownerB, before.ownerB); assert.deepEqual(after.denied, before.denied); assert.deepEqual(after.systemUnits, before.systemUnits)
    assert.deepEqual(Object.keys(after.ownerA).sort(), Object.keys(before.ownerA).sort())
    for (const [table, rows] of Object.entries(before.ownerA)) if (!allowed.includes(table)) assert.deepEqual(after.ownerA[table], rows, 'Unintended captured owner A mutation: ' + table)
  }
  const facts = async () => {
    const value = await bounded(readNativeAcceptanceFacts, 'Independent native acceptance facts')
    assert.deepEqual(Object.keys(value).sort(), ['acceptanceCurrent', 'documentFingerprint', 'termsFingerprint'])
    assert.match(value.documentFingerprint, /^[0-9a-f]{32}$/); assert.match(value.termsFingerprint, /^[0-9a-f]{32}$/)
    assert.equal(typeof value.acceptanceCurrent, 'boolean')
    return value
  }
  const documentMatches = (document, rows, note) => {
    const q = rows.ownerA.quotes[0]
    assert.equal(document.quote_id, fixture.quoteA); assert.equal(document.notes, note); assert.equal(document.terms_text, fixture.termsA)
    assert.equal(document.status, 'sent'); assert.equal(document.offered_option_id, null); assert.deepEqual(document.options, [])
    for (const field of ['customer_name', 'quote_number', 'address', 'service_type', 'valid_until', 'initial_price', 'travel_fee', 'addons_total', 'total',
      'weekly_price', 'biweekly_price', 'monthly_price', 'deposit_type', 'deposit_value', 'selected_option_id']) assert.deepEqual(document[field], q[field], 'Native public quote field ' + field)
    assert.equal(document.gst_percent, rows.ownerA.business_settings[0].gst_percent); assert.equal(document.company_name, rows.ownerA.business_settings[0].company_name)
    assert.deepEqual(document.included_addon_ids, [fixture.addonIdsA[0]])
    assert.deepEqual(document.addons.map(addon => addon.id), fixture.addonIdsA)
    for (let index = 0; index < document.addons.length; index++) for (const [field, value] of Object.entries(document.addons[index])) assert.deepEqual(value, rows.ownerA.quote_addons[index][field])
    assert.equal(document.services.length, 3)
    for (let index = 0; index < document.services.length; index++) for (const [field, value] of Object.entries(document.services[index])) assert.deepEqual(value, rows.ownerA.quote_services[index][field])
    assert.equal(JSON.stringify(document).includes(q.internal_notes), false, 'Public preview must not leak internal notes')
  }
  try {
    assert.equal(baseURL, 'http://localhost:3000'); assert.equal(browser.browserType().name(), 'chromium'); assert.equal(browser.isConnected(), true)
    for (const callback of [readIndependentRows, readFreshOwnerRows, readNativeAcceptanceFacts]) assert.equal(typeof callback, 'function')
    for (const field of ['ownerA', 'ownerB', 'denied', 'quoteA', 'customerA']) assert.ok(uuid(fixture[field]))
    for (const field of ['portalTokenA', 'portalTokenB', 'revokedPortalTokenA']) assert.ok(typeof fixture[field] === 'string' && fixture[field].length >= 20 && fixture[field].length <= 10_000)
    assert.equal(new Set([fixture.portalTokenA, fixture.portalTokenB, fixture.revokedPortalTokenA]).size, 3)
    assert.equal(fixture.acceptanceVersioned, true); assert.equal(fixture.termsA, termsText)
    assert.ok(Array.isArray(fixture.addonIdsA) && fixture.addonIdsA.length === 2 && fixture.addonIdsA.every(uuid))
    assert.ok(Array.isArray(fixture.before.ownerA.notifications), 'Versioned proof must observe native notification rows')
    const bundle = await loadCanonicalWire(); wire = bundle.wire; report.evidence.push(bundle.evidence)
    report.browserVersion = browser.version()
    const owner = await newPage('ownerA'), portal = await newPage('portal')
    const previewRequest = { version: 1, quoteId: fixture.quoteA, optionId: null, portalToken: fixture.portalTokenA }
    await check('real owner loads the sent quote through canonical verified baseline while portal context has no owner session', async () => {
      await owner.page.goto(baseURL + '/login?quoteId=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
      await owner.page.waitForFunction(() => document.querySelector('[data-testid="login-ready"]')?.textContent === 'ready')
      await owner.page.getByLabel('Email', { exact: true }).fill(fixture.emailA); await owner.page.getByLabel('Password', { exact: true }).fill(fixture.password)
      await Promise.all([owner.page.waitForURL(url => url.origin === baseURL && url.pathname === '/quote' && url.searchParams.get('quoteId') === fixture.quoteA),
        owner.page.getByRole('button', { name: 'Sign in', exact: true }).click()])
      await owner.page.locator('textarea[name="notes"]').waitFor({ state: 'visible' })
      await portal.page.goto(baseURL + '/login?quoteId=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
      assert.equal((await portal.context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).length, 0)
      assert.ok((await owner.context.cookies()).some(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)))
      await drain(); const baseline = responses.filter(r => r.context === 'ownerA' && r.path === '/api/baseline').at(-1)
      assert.ok(baseline); assert.equal(baseline.status, 200); assert.equal(baseline.body.code, 'baseline'); assert.equal(baseline.body.ownerId, fixture.ownerA)
      assert.equal(baseline.body.quoteId, fixture.quoteA); assert.equal(baseline.noStore, true)
      assert.equal(fixture.before.ownerA.quotes[0].status, 'sent'); assert.ok(fixture.before.ownerA.quotes[0].sent_at)
      assert.deepEqual(await bounded(readIndependentRows, 'Initial invariant read'), fixture.before)
      initialFacts = await facts(); assert.equal(initialFacts.acceptanceCurrent, false); await counts(owner.page)
      report.evidence.push({ kind: 'real-owner-and-private-portal-authority', actualOwnerAuthCookie: true, portalOwnerAuthCookie: false,
        baselineDigest: digest(baseline.body), beforeDigest: digest(fixture.before), initialNativeFacts: initialFacts })
    })
    await check('private customer token obtains exact native preview V1 without any selected row mutations', async () => {
      const result = await portalPost(portal.page, acceptancePaths[0], previewRequest, 'preview-v1')
      assert.equal(result.status, 200); previewV1 = wire.parsePilotAcceptancePreview(result.body, previewRequest)
      assert.ok(previewV1?.code === 'preview'); documentMatches(previewV1.expected.offered.public, fixture.before, fixture.before.ownerA.quotes[0].notes)
      assert.equal(previewV1.expected.priorAcceptanceId, null); assert.equal(previewV1.expected.priorAcceptanceSeq, null)
      oldIntent = wire.buildPilotAcceptanceCommitRequest(previewRequest, previewV1.expected, {
        addonIds: previewV1.expected.offered.public.included_addon_ids, reason: null, note: null, termsAck: true, clientOperationId: randomUUID() })
      assert.deepEqual(await bounded(readIndependentRows, 'Preview V1 invariant read'), fixture.before); assert.deepEqual(await facts(), initialFacts)
      report.evidence.push({ kind: 'preview-v1-zero-writes', previewRevision: previewV1.expected.previewRevision, previewDigest: digest(previewV1),
        offeredAmount: previewV1.expected.offered.public.accepted_amount, includedAddonIds: previewV1.expected.offered.public.included_addon_ids, exactTermsObserved: true })
    })
    await check('one actual owner form Save commits public scope V2 and preserves the selected add-on configuration', async () => {
      await owner.page.locator('textarea[name="notes"]').fill(noteV2)
      const form = owner.page.locator('form').filter({ has: owner.page.locator('input[name="initial_price"]') })
      assert.equal(await form.evaluate(node => node.noValidate), false); assert.equal(await form.evaluate(node => node.checkValidity()), true)
      const [response] = await Promise.all([owner.page.waitForResponse(r => new URL(r.url()).pathname === '/api/save' && new URL(r.url()).origin === baseURL),
        owner.page.locator('button[type="submit"]:visible').click()])
      saveIntent = response.request().postDataJSON(); saveReceipt = await response.json()
      assert.equal(response.status(), 200); assert.equal(saveReceipt.code, 'committed'); assert.equal(saveReceipt.quote_id, fixture.quoteA); assert.equal(saveReceipt.owner_id, fixture.ownerA)
      assert.equal(saveReceipt.client_operation_id, saveIntent.clientOperationId); assert.equal(saveReceipt.editor_generation, saveIntent.editorGeneration)
      assert.equal(saveReceipt.before_revision, saveIntent.expectedEditorRevision); assert.notEqual(saveReceipt.after_revision, saveReceipt.before_revision)
      assert.equal(saveIntent.values.notes, noteV2); assert.equal(saveReceipt.quote.notes, noteV2)
      await owner.page.getByText('Submitted version saved', { exact: true }).waitFor({ state: 'visible' }); await counts(owner.page)
      afterSave = await bounded(readIndependentRows, 'Independent normal Save COMMIT read')
      unchangedOutside(fixture.before, afterSave, ['quotes', 'quote_services'])
      assert.equal(afterSave.ownerA.quotes[0].notes, noteV2); assert.equal(afterSave.ownerA.quotes[0].status, 'sent')
      for (const [field, value] of Object.entries(saveReceipt.quote)) assert.deepEqual(comparable(afterSave.ownerA.quotes[0][field]), comparable(value))
      assert.deepEqual(comparable(afterSave.ownerA.quote_services), comparable(saveReceipt.services))
      assert.deepEqual(afterSave.ownerA.quote_services.map(service => service.sort_order), [0, 1, 2])
      assert.equal(afterSave.ownerA.quote_acceptances.length, 0)
      savedFacts = await facts(); assert.equal(savedFacts.acceptanceCurrent, false); assert.notEqual(savedFacts.documentFingerprint, initialFacts.documentFingerprint)
      assert.equal(savedFacts.termsFingerprint, initialFacts.termsFingerprint)
      report.evidence.push({ kind: 'normal-owner-save-v2', clientOperationId: saveIntent.clientOperationId, receiptDigest: digest(saveReceipt),
        afterSaveDigest: digest(afterSave), publicScopeChanged: true, addonRowsUnchanged: true, otherOwnersUnchanged: true, nativeFacts: savedFacts })
    })
    await check('the exact old preview and operation receive bound quote_changed refusal with zero partial state', async () => {
      const result = await portalPost(portal.page, acceptancePaths[1], oldIntent, 'stale-commit')
      assert.equal(result.status, 409)
      const parsed = wire.parsePilotAcceptanceCommitReply(result.body, oldIntent)
      assert.ok(parsed); assert.deepEqual(parsed, { code: 'refused', reason: 'quote_changed', clientOperationId: oldIntent.clientOperationId,
        previewRevision: previewV1.expected.previewRevision })
      assert.deepEqual(await bounded(readIndependentRows, 'Stale acceptance invariant read'), afterSave); assert.deepEqual(await facts(), savedFacts)
      report.evidence.push({ kind: 'stale-version-refused', status: result.status, reason: parsed.reason, clientOperationId: parsed.clientOperationId,
        previewRevision: parsed.previewRevision, allCapturedRowsUnchanged: true, acceptanceRows: 0 })
    })
    await check('an explicit fresh preview V2 contains current scope, original terms and exact included add-on IDs', async () => {
      const result = await portalPost(portal.page, acceptancePaths[0], previewRequest, 'preview-v2')
      assert.equal(result.status, 200); previewV2 = wire.parsePilotAcceptancePreview(result.body, previewRequest)
      assert.ok(previewV2?.code === 'preview'); assert.notEqual(previewV2.expected.previewRevision, previewV1.expected.previewRevision)
      documentMatches(previewV2.expected.offered.public, afterSave, noteV2)
      assert.equal(previewV1.expected.offered.public.notes, fixture.before.ownerA.quotes[0].notes, 'Previously reviewed expected document stays immutable')
      newIntent = wire.buildPilotAcceptanceCommitRequest(previewRequest, previewV2.expected, {
        addonIds: previewV2.expected.offered.public.included_addon_ids, reason: null, note: null, termsAck: true, clientOperationId: randomUUID() })
      assert.notEqual(newIntent.clientOperationId, oldIntent.clientOperationId)
      assert.deepEqual(await bounded(readIndependentRows, 'Preview V2 invariant read'), afterSave); assert.deepEqual(await facts(), savedFacts)
      report.evidence.push({ kind: 'explicit-fresh-preview-v2', previewRevision: previewV2.expected.previewRevision, previewDigest: digest(previewV2),
        offeredAmount: previewV2.expected.offered.public.accepted_amount, includedAddonIds: newIntent.addonIds, termsAck: newIntent.termsAck, previewZeroWrites: true })
    })
    await check('one fresh portal acceptance normally commits a native ledger and its documented audit and notification effects', async () => {
      const result = await portalPost(portal.page, acceptancePaths[1], newIntent, 'fresh-commit')
      assert.equal(result.status, 200); acceptedReply = wire.parsePilotAcceptanceCommitReply(result.body, newIntent)
      assert.ok(acceptedReply?.code === 'accepted'); const receipt = acceptedReply.receipt
      afterAccepted = await bounded(readIndependentRows, 'Independent accepted COMMIT read')
      unchangedOutside(afterSave, afterAccepted, ['quotes', 'quote_addons', 'quote_acceptances', 'audit_events', 'notifications'])
      assert.equal(afterAccepted.ownerA.quotes.length, 1); assert.equal(afterAccepted.ownerA.quote_acceptances.length, 1)
      const quote = afterAccepted.ownerA.quotes[0], ledger = afterAccepted.ownerA.quote_acceptances[0], document = previewV2.expected.offered.public
      assert.equal(quote.id, fixture.quoteA); assert.equal(quote.status, 'accepted'); assert.equal(quote.accepted_price, document.accepted_amount)
      for (const [field, value] of Object.entries(afterSave.ownerA.quotes[0])) {
        if (!['status', 'accepted_price', 'accepted_after_followup', 'follow_up_count_at_acceptance', 'updated_at'].includes(field)) {
          assert.deepEqual(quote[field], value, 'Acceptance must preserve other native quote field ' + field)
        }
      }
      assert.equal(quote.accepted_after_followup, Number(afterSave.ownerA.quotes[0].follow_up_count ?? 0) > 0)
      assert.equal(quote.follow_up_count_at_acceptance, afterSave.ownerA.quotes[0].follow_up_count ?? 0)
      assert.equal(receipt.accepted_amount, document.accepted_amount); assert.equal(ledger.accepted_amount, document.accepted_amount)
      assert.equal(ledger.id, receipt.acceptance_id); assert.equal(ledger.seq, receipt.acceptance_seq); assert.equal(ledger.seq, 1)
      assert.equal(ledger.user_id, fixture.ownerA); assert.equal(ledger.quote_id, fixture.quoteA)
      assert.equal(ledger.kind, 'customer'); assert.equal(ledger.source, 'portal'); assert.equal(ledger.actor_type, 'customer')
      assert.equal(ledger.actor_id, fixture.customerA); assert.equal(ledger.customer_id, fixture.customerA)
      assert.equal(receipt.kind, ledger.kind); assert.equal(receipt.source, ledger.source); assert.equal(receipt.actor_id, ledger.actor_id)
      assert.equal(receipt.customer_id, ledger.customer_id); assert.equal(receipt.previous_acceptance_id, ledger.supersedes_id)
      assert.equal(ledger.on_behalf_reason, null); assert.equal(ledger.on_behalf_note, null); assert.equal(ledger.supersedes_id, null)
      assert.equal(ledger.selected_option_id, null); assert.equal(quote.selected_option_id, null)
      assert.equal(ledger.terms_required, true); assert.equal(ledger.terms_acknowledged, true); assert.equal(ledger.terms_text, fixture.termsA)
      const native = await facts(); assert.equal(native.acceptanceCurrent, true)
      assert.equal(ledger.document_fingerprint, native.documentFingerprint); assert.equal(receipt.document_fingerprint, native.documentFingerprint)
      assert.equal(ledger.terms_fingerprint, native.termsFingerprint); assert.equal(receipt.terms_fingerprint, native.termsFingerprint)
      assert.equal(native.documentFingerprint, savedFacts.documentFingerprint); assert.equal(native.termsFingerprint, savedFacts.termsFingerprint)
      for (const field of ['quote_number', 'customer_name', 'address', 'service_type', 'notes', 'initial_price', 'travel_fee', 'total', 'valid_until', 'deposit_type', 'deposit_value']) {
        assert.deepEqual(ledger.document[field], quote[field], 'Immutable native ledger document ' + field)
      }
      assert.equal(ledger.document.notes, noteV2); assert.deepEqual(ledger.document.option, null); assert.deepEqual(ledger.document.options_offered, [])
      const addons = afterAccepted.ownerA.quote_addons
      assert.equal(addons.length, 2); assert.deepEqual(addons.map(addon => addon.id), fixture.addonIdsA)
      assert.deepEqual(addons.filter(addon => addon.is_selected).map(addon => addon.id).sort(), newIntent.addonIds)
      assert.deepEqual(receipt.addon_ids, newIntent.addonIds)
      for (let index = 0; index < addons.length; index++) {
        const addon = addons[index], original = afterSave.ownerA.quote_addons[index]
        for (const field of Object.keys(original)) if (!['selected_via', 'selected_at', 'updated_at'].includes(field)) assert.deepEqual(addon[field], original[field], 'Acceptance preserves add-on commercial field ' + field)
        assert.equal(addon.selected_via, index === 0 ? 'portal' : null); assert.equal(addon.selected_at !== null, index === 0)
      }
      assert.deepEqual(ledger.document.addons.map(addon => addon.id).sort(), newIntent.addonIds)
      assert.equal(ledger.document.services.length, afterAccepted.ownerA.quote_services.length)
      for (let index = 0; index < ledger.document.services.length; index++) for (const [field, value] of Object.entries(ledger.document.services[index])) {
        assert.deepEqual(value, afterAccepted.ownerA.quote_services[index][field], 'Immutable ledger service field ' + index + '/' + field)
      }
      const newRows = table => {
        const prior = new Map(afterSave.ownerA[table].map(row => [row.id, row])), added = []
        for (const row of afterAccepted.ownerA[table]) { if (prior.has(row.id)) { assert.deepEqual(row, prior.get(row.id)); prior.delete(row.id) } else added.push(row) }
        assert.equal(prior.size, 0, 'Existing ' + table + ' rows must remain'); assert.equal(added.length, 1); return added[0]
      }
      const audit = newRows('audit_events'), notification = newRows('notifications')
      assert.equal(audit.user_id, fixture.ownerA); assert.equal(audit.action, 'quote_accepted'); assert.equal(audit.entity_type, 'quote'); assert.equal(audit.entity_id, fixture.quoteA)
      assert.equal(audit.customer_id, fixture.customerA); assert.equal(audit.before.status, 'sent'); assert.equal(audit.after.status, 'accepted')
      assert.equal(audit.after.acceptance_kind, 'customer'); assert.equal(audit.after.accepted_price, document.accepted_amount)
      assert.equal(notification.user_id, fixture.ownerA); assert.equal(notification.type, 'quote_accepted'); assert.equal(notification.entity_type, 'quote')
      assert.equal(notification.entity_id, fixture.quoteA); assert.equal(notification.customer_id, fixture.customerA); assert.equal(notification.amount, quote.total)
      assert.equal(notification.href, '/dashboard/quotes/' + fixture.quoteA)
      report.evidence.push({ kind: 'normal-accepted-commit', clientOperationId: newIntent.clientOperationId, previewRevision: previewV2.expected.previewRevision,
        responseDigest: digest(acceptedReply), afterAcceptedDigest: digest(afterAccepted), acceptanceId: receipt.acceptance_id, acceptanceSeq: receipt.acceptance_seq,
        acceptedAmount: receipt.accepted_amount, nativeFacts: native, includedAddonIds: receipt.addon_ids, termsAcknowledged: true,
        auditAction: audit.action, notificationType: notification.type, otherOwnersUnchanged: true })
    })
    await check('fresh real owner Auth and ordered PostgREST read the same committed quote and services without another write', async () => {
      const fresh = await bounded(readFreshOwnerRows, 'Fresh Auth/PostgREST accepted readback')
      assert.equal(fresh.ownerId, fixture.ownerA); assert.deepEqual(comparable(fresh.quote), comparable(afterAccepted.ownerA.quotes[0]))
      assert.deepEqual(comparable(fresh.services), comparable(afterAccepted.ownerA.quote_services))
      assert.deepEqual(await bounded(readIndependentRows, 'Fresh Auth invariant read'), afterAccepted); await counts(owner.page)
      report.evidence.push({ kind: 'fresh-auth-current-accepted-facts', ownerId: fresh.ownerId, quoteDigest: digest(fresh.quote), orderedServicesDigest: digest(fresh.services),
        browserSessionReused: false, matchesIndependentSql: true, noAcceptanceReplay: true })
    })
    await check('foreign-customer and revoked portal tokens cannot preview the quote or mutate any captured row', async () => {
      for (const [label, token] of [['foreign-token', fixture.portalTokenB], ['revoked-token', fixture.revokedPortalTokenA]]) {
        const request = { ...previewRequest, portalToken: token }, result = await portalPost(portal.page, acceptancePaths[0], request, label)
        assert.equal(result.status, 404); const parsed = wire.parsePilotAcceptancePreview(result.body, request)
        assert.deepEqual(parsed, { code: 'refused', reason: 'not_found' })
        assert.deepEqual(await bounded(readIndependentRows, 'Refused token invariant read'), afterAccepted)
      }
      assert.equal((await portal.context.cookies()).filter(cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)).length, 0)
      report.evidence.push({ kind: 'portal-authority-refusals', foreignStatus: 404, revokedStatus: 404, allCapturedRowsUnchanged: true, rawTokensRecorded: false })
    })
    await check('observed browser IO is exactly one owner Save and two explicit acceptance attempts with no token disclosure or replay', async () => {
      await drain(); await counts(owner.page); assert.deepEqual(report.failures, [])
      assert.deepEqual(saveRequests, [{ context: 'ownerA', body: saveIntent }])
      assert.deepEqual(portalCalls.map(call => [call.label, call.path, call.status, call.code]), [
        ['preview-v1', acceptancePaths[0], 200, 'preview'], ['stale-commit', acceptancePaths[1], 409, 'refused'],
        ['preview-v2', acceptancePaths[0], 200, 'preview'], ['fresh-commit', acceptancePaths[1], 200, 'accepted'],
        ['foreign-token', acceptancePaths[0], 404, 'refused'], ['revoked-token', acceptancePaths[0], 404, 'refused'],
      ])
      const acceptanceResponses = responses.filter(response => acceptancePaths.includes(response.path))
      assert.equal(acceptanceResponses.length, 6)
      assert.deepEqual(acceptanceResponses.map(response => [response.context, response.path, response.status, response.body.code]),
        portalCalls.map(call => ['portal', call.path, call.status, call.code]))
      assert.equal(responses.filter(response => response.path === '/api/save').length, 1)
      for (const response of responses) assert.equal(response.noStore, true)
      for (const request of report.requests) {
        if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) continue
        assert.ok(request.method === 'POST' && (request.origin === baseURL && ['/api/baseline', '/api/save', ...acceptancePaths].includes(request.path)
          || request.origin === 'http://127.0.0.1:8000' && request.context === 'ownerA' && ['/auth/v1/token', '/rest/v1/rpc/current_app_role'].includes(request.path)),
        'Unexpected browser mutation/capability: ' + request.method + ' ' + request.path)
      }
      assert.equal(report.requests.filter(request => request.path === '/api/acceptance/commit').length, 2)
      assert.deepEqual(await bounded(readIndependentRows, 'Final invariant read'), afterAccepted)
      report.evidence.push({ kind: 'sequential-version-boundary', browserSaveRequests: 1, acceptanceCommitRequests: 2, acceptedReplies: 1, staleRefusals: 1,
        portalPreviews: 4, portalCalls, acceptanceUiClaimed: false, concurrencyClaimed: false, recoveryAttributionClaimed: false })
    })
    report.pass = report.tests.length === 9 && report.tests.every(test => test.pass)
  } catch (error) { report.error = { phase, message: safeError(error) }; report.pass = false }
  finally {
    for (const { context, entry } of contexts.reverse()) {
      try { await bounded(() => context.close(), 'Owned context closure', 20_000); entry.closed = true }
      catch { report.failures.push({ kind: 'context-close', context: entry.name }) }
    }
    await drain()
    report.allOpenedContextsClosed = report.contexts.filter(entry => entry.opened).every(entry => entry.closed)
    report.allContextsClosed = report.contexts.every(entry => entry.opened && entry.closed)
    report.responseSummary = responses.map(response => ({ context: response.context, path: response.path, status: response.status,
      code: ['baseline', 'committed', 'preview', 'refused', 'accepted', 'unknown'].includes(response.body?.code) ? response.body.code : 'invalid', noStore: response.noStore }))
    report.pass = report.pass && report.contexts.length === 2 && report.allContextsClosed && report.failures.length === 0
  }
  let serialized = JSON.stringify(report)
  for (const secret of secrets) if (serialized.includes(secret)) {
    report.pass = false; report.failures.push({ kind: 'private-credential-evidence-refused' })
    serialized = JSON.stringify(report)
    for (const credential of secrets) serialized = serialized.replaceAll(credential, '[redacted]')
    return JSON.parse(serialized)
  }
  return report
}
