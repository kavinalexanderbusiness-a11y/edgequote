import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Real Auth/HTTP and native owner prerequisite, separate from portal versioning.
// The only intentional business mutation is removal of synthetic owner B's
// settings by the driver, after fresh HTTP authority and before native dispatch.
export async function runAcceptanceAuthorityBrowser({ browser, baseURL, fixture, readIndependentRows, authorityGate }) {
  const report = { pass: false, tests: [], evidence: [], requests: [], failures: [], contexts: [],
    scope: 'Owner-on-behalf eligibility and sequential revocation between real Auth/role verification and native acceptance dispatch.',
    limits: ['This is an authority prerequisite, not portal versioning or an acceptance UI test.',
      'The deterministic pre-dispatch barrier is not an observed database lock race.',
      'Reconciliation remains UNKNOWN and cannot attribute an earlier operation.',
      'Readback covers 23 selected table families plus shared units; Auth rows and private portal tokens are excluded.'] }
  const contexts = []
  let phase = 'initialization', ownerPreview, commitRequest, afterRevocation
  const safeError = error => String(error instanceof Error ? error.message : 'Unknown authority error')
    .replaceAll(fixture.password, '[private fixture value]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[private token]').slice(0, 1200)
  const check = async (name, work) => {
    phase = name
    try { await work(); report.tests.push({ name, pass: true }) }
    catch (error) { report.tests.push({ name, pass: false, error: safeError(error) }); throw error }
  }
  const open = async label => {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const entry = { label, opened: true, closed: false }; report.contexts.push(entry); contexts.push({ context, entry })
    context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(45000)
    context.on('request', request => {
      const url = new URL(request.url())
      report.requests.push({ label, method: request.method(), origin: url.origin, path: url.pathname })
      if (!['http://localhost:3000', 'http://127.0.0.1:8000'].includes(url.origin)) report.failures.push('Unexpected request origin')
    })
    const page = await context.newPage()
    page.on('pageerror', error => report.failures.push(safeError(error)))
    return page
  }
  const login = async (page, email, quoteId) => {
    await page.goto(baseURL + '/login?quoteId=' + quoteId, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelector('[data-testid="login-ready"]')?.textContent === 'ready')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(fixture.password)
    await Promise.all([page.waitForURL(url => url.pathname === '/quote'), page.getByRole('button', { name: 'Sign in', exact: true }).click()])
  }
  const post = (page, mode, body) => page.evaluate(async ({ mode, body }) => {
    const response = await fetch('/api/acceptance/' + mode, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json(), noStore: response.headers.get('cache-control') === 'no-store' }
  }, { mode, body })
  const previewRequest = quoteId => ({ version: 1, quoteId, optionId: null })
  const refused = (result, status, reason, request) => {
    assert.equal(result.status, status); assert.equal(result.noStore, true)
    assert.deepEqual(result.body, { code: 'refused', ...(request ? { clientOperationId: request.clientOperationId,
      previewRevision: request.expected.previewRevision } : {}), reason })
  }
  try {
    assert.equal(baseURL, 'http://localhost:3000')
    const b = await open('healthy-then-revoked-ownerB')
    await check('real owner B receives a current preview through mandatory verified owner authority', async () => {
      await login(b, fixture.emailB, fixture.quoteB)
      await b.locator('textarea[name="notes"]').waitFor({ state: 'visible' })
      const result = await post(b, 'preview', previewRequest(fixture.quoteB))
      assert.equal(result.status, 200); assert.equal(result.noStore, true); assert.equal(result.body.code, 'preview')
      assert.equal(result.body.expected.quoteId, fixture.quoteB)
      ownerPreview = result.body
      commitRequest = { ...previewRequest(fixture.quoteB), expected: ownerPreview.expected,
        addonIds: ownerPreview.expected.offered.public.included_addon_ids, reason: 'text_message',
        note: 'Synthetic owner confirms this displayed version only', termsAck: true, clientOperationId: randomUUID() }
      assert.deepEqual(await readIndependentRows(), fixture.before)
      report.evidence.push({ kind: 'eligible-owner-preview', ownerId: fixture.ownerB, previewDigest: digest(ownerPreview), zeroBusinessWrites: true })
    })
    await check('native acceptance refuses revocation committed after actual HTTP owner verification', async () => {
      const pending = post(b, 'commit', commitRequest)
      void pending.catch(() => {})
      const held = await Promise.race([authorityGate.waitHeld(), pending.then(() => { throw Error('Acceptance returned before the owner-authority barrier') })])
      assert.equal(held.operationId, commitRequest.clientOperationId); assert.equal(held.ownerId, fixture.ownerB); assert.equal(held.quoteId, fixture.quoteB)
      assert.deepEqual(await readIndependentRows(), fixture.before)
      afterRevocation = await authorityGate.revokeAndRelease(commitRequest.clientOperationId)
      assert.deepEqual(afterRevocation.ownerA, fixture.before.ownerA); assert.deepEqual(afterRevocation.denied, fixture.before.denied)
      assert.deepEqual(afterRevocation.systemUnits, fixture.before.systemUnits)
      assert.deepEqual(afterRevocation.ownerB.business_settings, [])
      for (const [table, rows] of Object.entries(fixture.before.ownerB)) if (table !== 'business_settings') assert.deepEqual(afterRevocation.ownerB[table], rows)
      refused(await pending, 403, 'forbidden', commitRequest)
      assert.deepEqual(await readIndependentRows(), afterRevocation)
      assert.equal(afterRevocation.ownerB.quote_acceptances.length, 0)
      report.evidence.push({ kind: 'revoked-between-authority-and-native', operationId: commitRequest.clientOperationId,
        freshHttpOwnerAuthorityPassed: true, settingsDeletionCommittedBeforeNativeDispatch: true, nativeRefusal: 'forbidden', status: 403,
        beforeDigest: digest(fixture.before), afterRevocationDigest: digest(afterRevocation), acceptanceLedgerRows: 0, databaseLockRaceClaimed: false })
    })
    await check('fresh revoked-owner HTTP preview and commit refuse before store access while reconciliation remains unknown', async () => {
      const beforeEvents = await authorityGate.readEvents()
      refused(await post(b, 'preview', previewRequest(fixture.quoteB)), 403, 'forbidden')
      const next = { ...commitRequest, clientOperationId: randomUUID() }
      refused(await post(b, 'commit', next), 403, 'forbidden', next)
      const reconciled = await post(b, 'reconcile', commitRequest)
      assert.equal(reconciled.status, 503); assert.equal(reconciled.noStore, true)
      assert.deepEqual(reconciled.body, { code: 'unknown', clientOperationId: commitRequest.clientOperationId, previewRevision: commitRequest.expected.previewRevision })
      assert.deepEqual(await authorityGate.readEvents(), beforeEvents, 'Pre-dispatch refusals must never call the acceptance store')
      assert.deepEqual(await readIndependentRows(), afterRevocation)
      report.evidence.push({ kind: 'fresh-revoked-http-gate', previewStatus: 403, commitStatus: 403, storeCalls: 0,
        reconciliationRemainsUnknown: true, allCapturedRowsUnchanged: true })
    })
    await check('direct actual service RPC cannot bypass the native owner fence', async () => {
      for (const mode of ['preview', 'commit', 'reconcile']) {
        const native = await authorityGate.directNative(mode, commitRequest)
        assert.deepEqual(native, { code: mode === 'reconcile' ? 'unknown' : 'forbidden' })
      }
      assert.deepEqual(await readIndependentRows(), afterRevocation)
      report.evidence.push({ kind: 'independent-native-owner-fence', actualPostgrestServiceRpc: true, preview: 'forbidden', commit: 'forbidden',
        reconcile: 'unknown', allCapturedRowsUnchanged: true })
    })
    await check('a denied account with its own quote and a signed-out browser cannot gain owner acceptance authority', async () => {
      const denied = await open('denied-own-quote'); await login(denied, fixture.deniedEmail, fixture.quoteDenied)
      refused(await post(denied, 'preview', previewRequest(fixture.quoteDenied)), 403, 'forbidden')
      const anon = await open('anonymous')
      await anon.goto(baseURL + '/quote?quoteId=' + fixture.quoteB, { waitUntil: 'domcontentloaded' })
      refused(await post(anon, 'preview', previewRequest(fixture.quoteB)), 401, 'unauthenticated')
      assert.deepEqual(await readIndependentRows(), afterRevocation)
      report.evidence.push({ kind: 'owner-auth-refusals', deniedOwnQuoteStatus: 403, anonymousStatus: 401, allCapturedRowsUnchanged: true })
    })
    await check('the prerequisite has one held HTTP commit, separate direct RPC refusals and only its explicit synthetic revocation mutation', async () => {
      const events = await authorityGate.readEvents()
      assert.deepEqual(events.map(e => e.kind), ['acceptance-preview-dispatch', 'owner-authority-passed-before-native',
        'owner-settings-revocation-committed', 'acceptance-commit-dispatch', 'acceptance-commit-return'])
      for (const event of events) { assert.equal(event.ownerId, fixture.ownerB); assert.equal(event.quoteId, fixture.quoteB) }
      assert.deepEqual(await readIndependentRows(), afterRevocation); assert.deepEqual(report.failures, [])
      report.evidence.push({ kind: 'complete-owner-prerequisite', events, acceptedCommits: 0, noPortalVersioningClaim: true,
        heldHttpCommitNativeDispatches: 1, separateDirectNativeCalls: ['preview', 'commit', 'reconcile'],
        allowedMutation: 'Deletion of synthetic owner B business_settings only', allOtherCapturedRowsUnchanged: true })
    })
    report.pass = report.tests.length === 6 && report.tests.every(test => test.pass)
  } catch (error) { report.error = { phase, message: safeError(error) } }
  finally {
    for (const { context, entry } of contexts.reverse()) {
      try { await context.close(); entry.closed = true } catch { report.failures.push('Context closure failed') }
    }
    report.allOpenedContextsClosed = report.contexts.every(entry => entry.closed)
    report.pass = report.pass && report.contexts.length === 3 && report.allOpenedContextsClosed && report.failures.length === 0
  }
  return report
}
