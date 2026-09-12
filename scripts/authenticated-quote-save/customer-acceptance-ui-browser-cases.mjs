import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAcceptanceProofWire } from './versioned-acceptance-browser-cases.mjs'

// Actual customer clicks only. No fetch interception, injected controller state,
// replayed response, native-validation bypass or direct HTTP customer action.
const api = ['/api/baseline', '/api/save', '/api/acceptance/preview', '/api/acceptance/commit', '/api/acceptance/reconcile']
const sha = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const money = value => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2 }).format(value)
const authCookie = cookie => /^sb-.*-auth-token(?:\.\d+)?$/.test(cookie.name)
const noteV2 = 'Customer UI stale review: scope V2 saved by the actual owner'
const priceV2 = 151.23
const emailTables = ['pilot_quote_followup_workflows', 'pilot_email_send_attempts']
// Only these optional email row fields contain private routing/credential
// values. Comparisons and digests use the original rows; returned evidence is
// a separate redacted copy, including on a failed assertion.
function emailPrivateValues(value, result = new Set()) {
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['reply_token', 'reply_to', 'route_token', 'secret_ref', 'idempotency_key'].includes(key) && typeof child === 'string' && child.length) result.add(child)
    else emailPrivateValues(child, result)
  }
  return result
}
function profileRows(rows, fixture) {
  assert.ok(['absent', 'present'].includes(fixture.emailProfile), 'An explicit verified email profile is required')
  for (const owner of ['ownerA', 'ownerB', 'denied']) {
    assert.equal(Object.keys(rows[owner]).length, 23)
    for (const table of emailTables) assert.ok(Array.isArray(rows[owner][table]))
    if (fixture.emailProfile === 'absent' || owner !== 'ownerA') for (const table of emailTables) assert.deepEqual(rows[owner][table], [])
  }
  const workflows = rows.ownerA.pilot_quote_followup_workflows, attempts = rows.ownerA.pilot_email_send_attempts
  if (fixture.emailProfile === 'present') {
    assert.equal(workflows.length, 1); assert.equal(attempts.length, 1)
    const workflow = workflows[0], attempt = attempts[0]
    for (const row of [workflow, attempt]) {
      assert.equal(row.user_id, fixture.ownerA); assert.equal(row.quote_id, fixture.quoteA); assert.equal(row.customer_id, fixture.customerA)
    }
    assert.equal(workflow.state, 'held'); assert.equal(workflow.hold_reason, 'owner_paused')
    assert.equal(workflow.approved_by, fixture.ownerA); assert.equal(workflow.step_count, 1)
    assert.ok(Number.isFinite(Date.parse(workflow.held_at)))
    assert.equal(attempt.workflow_id, workflow.id); assert.equal(attempt.connection_id, workflow.connection_id)
    assert.equal(attempt.state, 'pending'); assert.equal(attempt.step, 1); assert.equal(attempt.fence, 0)
    for (const key of ['lease_until', 'first_started_at', 'provider_email_id', 'confirmed_at', 'message_id', 'notification_log_id', 'error_code']) assert.equal(attempt[key], null, 'Retained attempt remains unstarted: ' + key)
    assert.match(attempt.reply_token, /^[a-f0-9]{48}$/)
    assert.ok(typeof attempt.payload?.reply_to === 'string' && attempt.payload.reply_to.startsWith(attempt.reply_token + '@'))
  }
  return { profile: fixture.emailProfile, rowFamilies: 23, queriedRowFamilies: fixture.emailProfile === 'absent' ? 21 : 23,
    emailRelations: Object.fromEntries(emailTables.map(table => [table, fixture.emailProfile === 'absent' ? 'verified not installed; empty placeholder' : 'queried installed relation'])),
    workflows: workflows.length, attempts: attempts.length, workflowState: workflows[0]?.state ?? null,
    attemptState: attempts[0]?.state ?? null, retainedSha256: sha({ workflows, attempts }) }
}
async function bounded(work, label, ms = 30000) {
  let timer
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label + ' timed out')), ms) })]) }
  finally { clearTimeout(timer) }
}
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, comparable(child)]))
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value))
    return value.replace(/(?:Z|\+00:00)$/, '+00:00').replace(/(\.\d*?[1-9])0+(?=\+)/, '$1').replace(/\.0+(?=\+)/, '')
  return value
}
function unchangedOutside(before, after, allowed) {
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  for (const key of Object.keys(before)) if (key !== 'ownerA') assert.deepEqual(after[key], before[key], 'Control owner/shared rows changed: ' + key)
  assert.deepEqual(Object.keys(after.ownerA).sort(), Object.keys(before.ownerA).sort())
  for (const [table, rows] of Object.entries(before.ownerA)) if (!allowed.includes(table)) assert.deepEqual(after.ownerA[table], rows, 'Unintended mutation: ' + table)
}
function inserted(before, after, table) {
  const prior = new Map(before.ownerA[table].map(row => [row.id, row])), added = []
  for (const row of after.ownerA[table]) {
    if (prior.has(row.id)) { assert.deepEqual(row, prior.get(row.id)); prior.delete(row.id) } else added.push(row)
  }
  assert.equal(prior.size, 0); assert.equal(added.length, 1, 'One new ' + table + ' row'); return added[0]
}
function savedPriceSideEffects(before, after, fixture) {
  unchangedOutside(before, after, ['quotes', 'quote_services', 'audit_events', 'pricing_config_versions'])
  const oldQuote = before.ownerA.quotes[0], quote = after.ownerA.quotes[0], settings = before.ownerA.business_settings[0]
  const audit = inserted(before, after, 'audit_events')
  // Canonical audit_quotes records generated totals when initial price changes.
  // The authenticated adapter invokes native Save through its service client;
  // this audit row honestly carries system/service, not invented owner evidence.
  for (const [key, value] of Object.entries({ user_id: fixture.ownerA, action: 'quote_price_changed', entity_type: 'quote',
    entity_id: fixture.quoteA, entity_label: oldQuote.quote_number, customer_id: oldQuote.customer_id,
    before: { total: oldQuote.total }, after: { total: quote.total }, meta: null,
    actor_type: 'system', actor_id: null, actor_label: null, source: 'service' })) assert.deepEqual(audit[key], value, 'Save audit ' + key)
  assert.match(audit.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.ok(Number.isSafeInteger(audit.seq) && audit.seq > 0 && Number.isSafeInteger(audit.txid) && audit.txid > 0)
  assert.ok(Number.isFinite(Date.parse(audit.occurred_at)))
  assert.equal(before.ownerA.pricing_config_versions.length, 0, 'Fresh fixture has no recorded pricing version')
  const version = inserted(before, after, 'pricing_config_versions')
  const positive = (value, fallback) => Number(value ?? 0) > 0 ? value : fallback
  // Exact canonical ensure_pricing_config_version settings snapshot, not an
  // unrestricted allowance for provenance changes during the real owner Save.
  for (const [key, value] of Object.entries({ user_id: fixture.ownerA, source: 'recorded', engine_version: 'v1',
    note: 'Recorded by ensure_pricing_config_version on a detected settings change.',
    base_charge: positive(settings.pricing_base_charge, 28), mow_rate_per_1000: positive(settings.pricing_mow_rate, 15),
    budget_mult: 0.8, market_mult: 0.92, recommended_mult: positive(settings.pricing_recommended_mult, 1),
    premium_mult: positive(settings.pricing_premium_mult, 1.2), travel_rate_per_km: positive(settings.pricing_travel_rate, 1.5),
    crew_cost_per_hour: settings.crew_cost_per_hour ?? 40, fee_recovery_percent: settings.fee_recovery_percent ?? 3,
    payment_fee_strategy: settings.payment_fee_strategy ?? 'global_price_increase' })) assert.deepEqual(version[key], value, 'Save pricing version ' + key)
  assert.ok(Number.isFinite(Date.parse(version.created_at)))
  assert.match(version.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.equal(Date.parse(version.valid_from), Date.parse(version.created_at))
  assert.equal(quote.pricing_config_version_id, version.id); assert.equal(quote.price_source, 'engine')
  return { kind: 'native-save-price-side-effects', auditId: audit.id, auditSha256: sha(audit),
    pricingVersionId: version.id, pricingVersionSha256: sha(version), beforeTotal: oldQuote.total, afterTotal: quote.total,
    priorAuditRowsPreserved: true, exactPricingSettingsSnapshot: true }
}
function documentMatches(p, rows, fixture) {
  const q = rows.ownerA.quotes[0]
  assert.equal(p.quote_id, fixture.quoteA); assert.equal(p.status, 'sent'); assert.equal(p.terms_text, fixture.termsA)
  assert.equal(p.offered_option_id, null); assert.deepEqual(p.options, [])
  for (const key of ['customer_name', 'quote_number', 'address', 'service_type', 'notes', 'valid_until', 'initial_price', 'travel_fee', 'addons_total',
    'total', 'weekly_price', 'biweekly_price', 'monthly_price', 'deposit_type', 'deposit_value', 'selected_option_id']) assert.deepEqual(p[key], q[key], 'Native public ' + key)
  assert.equal(p.company_name, rows.ownerA.business_settings[0].company_name); assert.equal(p.gst_percent, rows.ownerA.business_settings[0].gst_percent)
  assert.deepEqual(p.included_addon_ids, [fixture.addonIdsA[0]])
  for (const table of ['services', 'addons']) {
    const stored = rows.ownerA['quote_' + table]; assert.equal(p[table].length, stored.length)
    for (let index = 0; index < stored.length; index++) for (const [key, value] of Object.entries(p[table][index])) assert.deepEqual(value, stored[index][key])
  }
}
function acceptedRows(before, after, intent, receipt, fixture, facts) {
  unchangedOutside(before, after, ['quotes', 'quote_addons', 'quote_acceptances', 'audit_events', 'notifications'])
  const q = after.ownerA.quotes[0], p = intent.expected.offered.public, ledger = inserted(before, after, 'quote_acceptances')
  assert.equal(after.ownerA.quotes.length, 1); assert.equal(after.ownerA.quote_acceptances.length, 1)
  assert.equal(q.status, 'accepted'); assert.equal(q.accepted_price, p.accepted_amount)
  for (const [key, value] of Object.entries(before.ownerA.quotes[0]))
    if (!['status', 'accepted_price', 'accepted_after_followup', 'follow_up_count_at_acceptance', 'updated_at'].includes(key)) assert.deepEqual(q[key], value, 'Acceptance preserves quote ' + key)
  assert.equal(q.accepted_after_followup, Number(before.ownerA.quotes[0].follow_up_count ?? 0) > 0)
  assert.equal(q.follow_up_count_at_acceptance, before.ownerA.quotes[0].follow_up_count ?? 0)
  for (const [key, value] of Object.entries({ id: receipt.acceptance_id, user_id: fixture.ownerA, quote_id: fixture.quoteA, seq: 1,
    kind: 'customer', source: 'portal', actor_type: 'customer', actor_id: fixture.customerA, customer_id: fixture.customerA,
    accepted_amount: p.accepted_amount, selected_option_id: null, supersedes_id: null, terms_required: true,
    terms_acknowledged: true, terms_text: fixture.termsA, on_behalf_reason: null, on_behalf_note: null })) assert.deepEqual(ledger[key], value, 'Ledger ' + key)
  for (const key of ['kind', 'source', 'actor_id', 'customer_id', 'accepted_amount', 'selected_option_id']) assert.deepEqual(receipt[key], ledger[key])
  assert.equal(receipt.acceptance_seq, 1); assert.equal(receipt.previous_acceptance_id, null)
  assert.equal(facts.acceptanceCurrent, true)
  for (const [key, fact] of [['document_fingerprint', 'documentFingerprint'], ['terms_fingerprint', 'termsFingerprint']]) {
    assert.equal(receipt[key], facts[fact]); assert.equal(ledger[key], facts[fact])
  }
  for (const key of ['quote_number', 'customer_name', 'address', 'service_type', 'notes', 'initial_price', 'travel_fee', 'total', 'valid_until', 'deposit_type', 'deposit_value']) assert.deepEqual(ledger.document[key], q[key])
  assert.equal(ledger.document.option, null); assert.deepEqual(ledger.document.options_offered, [])
  assert.deepEqual(receipt.addon_ids, intent.addonIds); assert.deepEqual(ledger.document.addons.map(row => row.id).sort(), intent.addonIds)
  assert.deepEqual(after.ownerA.quote_addons.map(row => row.id), fixture.addonIdsA)
  assert.deepEqual(after.ownerA.quote_addons.filter(row => row.is_selected).map(row => row.id).sort(), intent.addonIds)
  for (let index = 0; index < after.ownerA.quote_addons.length; index++) {
    const row = after.ownerA.quote_addons[index]
    for (const [key, value] of Object.entries(before.ownerA.quote_addons[index]))
      if (!['selected_via', 'selected_at', 'updated_at'].includes(key)) assert.deepEqual(row[key], value)
    assert.equal(row.selected_via, index === 0 ? 'portal' : null); assert.equal(row.selected_at !== null, index === 0)
  }
  assert.equal(ledger.document.services.length, after.ownerA.quote_services.length)
  for (let index = 0; index < ledger.document.services.length; index++)
    for (const [key, value] of Object.entries(ledger.document.services[index])) assert.deepEqual(value, after.ownerA.quote_services[index][key])
  const audit = inserted(before, after, 'audit_events'), notification = inserted(before, after, 'notifications')
  for (const [key, value] of Object.entries({ user_id: fixture.ownerA, action: 'quote_accepted', entity_type: 'quote', entity_id: fixture.quoteA, customer_id: fixture.customerA })) assert.deepEqual(audit[key], value)
  assert.equal(audit.before.status, 'sent'); assert.equal(audit.after.status, 'accepted'); assert.equal(audit.after.acceptance_kind, 'customer'); assert.equal(audit.after.accepted_price, p.accepted_amount)
  for (const [key, value] of Object.entries({ user_id: fixture.ownerA, type: 'quote_accepted', entity_type: 'quote', entity_id: fixture.quoteA,
    customer_id: fixture.customerA, amount: q.total, href: '/dashboard/quotes/' + fixture.quoteA })) assert.deepEqual(notification[key], value)
}

export async function runCustomerAcceptanceUIBrowser({ browser, baseURL, fixtures, readRows, readFacts, readFreshOwnerRows, outputDirectory, selectedCases = ['U1', 'U2'] }) {
  const report = { pass: false, tests: [], cases: [], contexts: [], failures: [], evidence: [], browserOwnedByCaller: true,
    scope: 'Actual dormant PortalClient acceptance UI, canonical hook/modal, real HTTP/native acceptance and one actual authenticated owner Save.',
    limits: ['The production PortalPage does not activate this capability.', 'Native current acceptance is a database oracle, not an invented UI badge.',
      'Recovery means explicit fresh review after a known stale refusal; no UNKNOWN attribution or response-loss recovery is claimed.',
      'Business comparisons cover the declared 23 table families, control owners and shared units, excluding Auth and private token rows.'] }
  const retainedSecrets = emailPrivateValues((fixtures ?? []).map(f => f.before))
  const secrets = new Set((fixtures ?? []).flatMap(f => [f.password, f.portalTokenA, f.portalTokenB, f.revokedPortalTokenA]).filter(value => typeof value === 'string' && value.length > 0))
  for (const value of retainedSecrets) secrets.add(value)
  const registerPrivateRows = value => { for (const item of emailPrivateValues(value)) { retainedSecrets.add(item); secrets.add(item) } return value }
  const safe = error => {
    let text = String(error instanceof Error ? error.message : error)
    for (const value of secrets) { text = text.replaceAll(value, '[private fixture value]'); text = text.replaceAll(encodeURIComponent(value), '[private fixture value]') }
    return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[private token]').slice(0, 1200)
  }
  const assertPrivateAbsent = text => {
    for (const value of secrets) assert.equal(text.includes(value), false, 'Private fixture value disclosed')
    assert.equal(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text), false, 'Auth token disclosed')
  }
  try {
    assert.equal(baseURL, 'http://localhost:3000'); assert.equal(browser.browserType().name(), 'chromium'); assert.equal(browser.isConnected(), true)
    assert.ok(JSON.stringify(selectedCases) === '["U1","U2"]' || JSON.stringify(selectedCases) === '["U2"]', 'Only the original UI suite or explicit U2 profile slice is supported')
    const profileSlice = selectedCases.length === 1
    report.selectedCases = [...selectedCases]
    report.expectedPhases = profileSlice ? 5 : 8
    if (profileSlice) report.limits.push('This selected U2 slice checks Save and portal acceptance under one verified email profile; identity reassignment, deletion/Undo, owner-on-behalf acceptance and lock schedules are not rerun.')
    assert.deepEqual(fixtures.map(f => f.id), selectedCases); assert.equal(new Set(fixtures.map(f => f.ownerA)).size, selectedCases.length)
    for (const callback of [readRows, readFacts, readFreshOwnerRows]) assert.equal(typeof callback, 'function')
    const { wire, evidence } = await loadAcceptanceProofWire(); report.evidence.push(evidence); report.browserVersion = browser.version()
    for (const fixture of fixtures) {
      const entry = { id: fixture.id, pass: false, phases: [], requests: [], evidence: [], captures: [], cleanup: {}, beforeRows: fixture.before }
      report.cases.push(entry)
      const contexts = [], tasks = [], captured = [], requests = [], metadata = new WeakMap()
      const viewport = fixture.id === 'U1' ? { width: 1440, height: 1100 } : { width: 390, height: 844 }
      let phase = 'preparation', successful = false, portal, owner, preview, preAcceptanceRows = fixture.before, finalRows, finalFacts, acceptedResponseOrder
      let networkOrder = 0
      const rows = async () => {
        const value = registerPrivateRows(await bounded(() => readRows(fixture), 'Independent fixture rows'))
        if (profileSlice) {
          profileRows(value, fixture)
          for (const owner of ['ownerA', 'ownerB', 'denied']) for (const table of emailTables) assert.deepEqual(value[owner][table], fixture.before[owner][table], 'Retained email rows changed: ' + owner + '.' + table)
        }
        return value
      }
      const facts = async () => {
        const value = await bounded(() => readFacts(fixture), 'Independent native facts')
        assert.deepEqual(Object.keys(value).sort(), ['acceptanceCurrent', 'documentFingerprint', 'termsFingerprint'])
        for (const key of ['documentFingerprint', 'termsFingerprint']) assert.match(value[key], /^[a-f0-9]{32}$/)
        assert.equal(typeof value.acceptanceCurrent, 'boolean'); return value
      }
      const check = async (name, work) => {
        phase = name
        try { await work(); entry.phases.push({ name, pass: true }) }
        catch (error) { entry.phases.push({ name, pass: false, error: safe(error) }); throw error }
      }
      const drain = async () => {
        await bounded(async () => { let length; do { length = tasks.length; await Promise.all(tasks) } while (length !== tasks.length) }, 'API observation drain')
      }
      const counts = path => requests.filter(item => item.path === path).length
      const inspectURL = raw => {
        const url = new URL(raw), origin = url.origin.replace(/^ws:/, 'http:')
        assert.ok(['http:', 'ws:'].includes(url.protocol) && [baseURL, 'http://127.0.0.1:8000'].includes(origin), 'Unapproved browser origin')
        return url
      }
      const newPage = async (label, size) => {
        const observed = { case: fixture.id, label, opened: false, closed: false, viewport: size }; report.contexts.push(observed)
        const context = await browser.newContext({ viewport: size, serviceWorkers: 'block' })
        contexts.push({ context, observed }); observed.opened = true; context.setDefaultTimeout(20000); context.setDefaultNavigationTimeout(45000)
        context.on('request', request => {
          try {
            const url = inspectURL(request.url())
            // Existing portal URLs legitimately contain the bearer token. No
            // raw URL, query, headers, RSC body or token enters the report.
            const path = url.pathname.startsWith('/portal/') ? '/portal/[private-token]' : safe(url.pathname)
            const record = { label, phase, method: request.method(), origin: url.origin, path, order: ++networkOrder }
            entry.requests.push(record); metadata.set(request, record)
            if (url.origin === baseURL && api.includes(url.pathname) && request.method() === 'POST')
              requests.push({ label, path: url.pathname, body: request.postDataJSON() })
            if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
              const appAllowed = url.origin === baseURL && request.method() === 'POST' && api.includes(url.pathname)
              const rpcAllowed = url.origin === 'http://127.0.0.1:8000' && request.method() === 'POST' &&
                ['/rest/v1/rpc/get_portal_data', '/rest/v1/rpc/portal_get_prefs', ...(label === 'owner' ? ['/auth/v1/token', '/rest/v1/rpc/current_app_role'] : [])].includes(url.pathname)
              assert.ok(appAllowed || rpcAllowed, 'Unapproved or legacy browser write path')
              if (url.origin === baseURL && url.pathname.startsWith('/api/acceptance/')) assert.equal(label, 'portal')
              if (url.origin === baseURL && ['/api/save', '/api/baseline'].includes(url.pathname)) assert.equal(label, 'owner')
            }
          } catch (error) { report.failures.push({ case: fixture.id, kind: 'request', error: safe(error) }) }
        })
        context.on('response', response => {
          const request = response.request(), record = metadata.get(request)
          if (record) record.status = response.status()
          const responseOrder = ++networkOrder
          const url = new URL(response.url())
          if (url.origin !== baseURL || !api.includes(url.pathname) || request.method() !== 'POST') return
          tasks.push((async () => {
            try {
              const body = await bounded(() => response.json(), 'Canonical API response', 20000)
              assertPrivateAbsent(JSON.stringify(body))
              captured.push({ label, path: url.pathname, status: response.status(), body, request: request.postDataJSON(), requestIdentity: request, responseOrder,
                noStore: /(?:^|,)\s*no-store(?:\s|,|$)/.test(response.headers()['cache-control'] ?? '') })
            } catch (error) { report.failures.push({ case: fixture.id, kind: 'api-response', error: safe(error) }) }
          })())
        })
        context.on('requestfailed', request => {
          const url = new URL(request.url())
          if (url.origin === baseURL && api.includes(url.pathname)) report.failures.push({ case: fixture.id, kind: 'api-request-failed', path: url.pathname })
        })
        const page = await context.newPage()
        page.on('pageerror', error => report.failures.push({ case: fixture.id, kind: 'page', error: safe(error) }))
        page.on('websocket', socket => { try { inspectURL(socket.url()) } catch (error) { report.failures.push({ case: fixture.id, kind: 'websocket', error: safe(error) }) } })
        return { page, context }
      }
      const observeAction = async (path, click) => {
        const received = portal.page.waitForResponse(response => new URL(response.url()).origin === baseURL && new URL(response.url()).pathname === path && response.request().method() === 'POST')
        const [response] = await Promise.all([received, click()]); await drain()
        const matched = captured.filter(item => item.requestIdentity === response.request())
        assert.equal(matched.length, 1, 'Exact actual request/response identity'); return matched[0]
      }
      const dialog = () => portal.page.getByRole('dialog', { name: 'Review and accept quote', exact: true })
      const primary = () => dialog().getByRole('button', { name: 'Accept this quote', exact: true })
      const privacy = async () => {
        const text = await portal.page.locator('body').innerText(); assertPrivateAbsent(text)
        const internal = fixture.before.ownerA.quotes[0].internal_notes
        if (internal) assert.equal(text.includes(internal), false, 'Private internal note rendered')
        for (const value of ['authorityFence', 'previewRevision', 'terms_payment_claim', 'internal_notes']) assert.equal(text.includes(value), false, 'Private implementation field rendered')
        const storage = await portal.page.evaluate(() => [localStorage, sessionStorage].flatMap(store => Array.from({ length: store.length }, (_, index) => [store.key(index), store.getItem(store.key(index))])))
        assertPrivateAbsent(JSON.stringify(storage))
        for (const pair of storage) for (const value of pair) assert.equal(/"(?:portalToken|previewRevision|authorityFence)"\s*:/.test(value ?? ''), false, 'Acceptance protocol persisted')
      }
      const geometry = async stage => {
        // Wait for actual modal effects/entrance animation; never suppress the
        // animation, change CSS or force an otherwise unreachable control.
        await portal.page.waitForFunction(() => {
          const element = document.querySelector('[role="dialog"]')
          return !!element && document.body.style.overflow === 'hidden'
            && element.getAnimations().every(animation => animation.playState === 'finished' || animation.playState === 'idle')
        })
        const measured = await dialog().evaluate(element => {
          const bounds = element.getBoundingClientRect(), overlay = element.parentElement, body = element.querySelector('.overflow-y-auto')
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
            overlayPosition: getComputedStyle(overlay).position, bodyOverflow: getComputedStyle(document.body).overflow,
            contentOverflow: body ? getComputedStyle(body).overflowY : null, scrollHeight: body?.scrollHeight ?? 0, clientHeight: body?.clientHeight ?? 0 }
        })
        assert.equal(measured.overlayPosition, 'fixed'); assert.equal(measured.bodyOverflow, 'hidden'); assert.equal(measured.contentOverflow, 'auto')
        assert.ok(measured.width > 0 && measured.height > 0 && measured.x >= -1 && measured.y >= -1
          && measured.x + measured.width <= measured.viewportWidth + 1 && measured.y + measured.height <= measured.viewportHeight + 1, 'Actual modal fits viewport')
        entry.evidence.push({ kind: 'actual-modal-layout', stage, ...measured })
      }
      const screenshot = async name => {
        if (!outputDirectory) return
        if (name === 'U1-preview-terms-unchecked') await dialog().getByRole('checkbox').scrollIntoViewIfNeeded()
        if (name === 'U2-stale-refusal') await dialog().getByRole('alert').scrollIntoViewIfNeeded()
        if (name === 'U2-recorded-acceptance') await dialog().getByText(/^Recorded amount: /).scrollIntoViewIfNeeded()
        await privacy(); await geometry(name)
        const path = join(outputDirectory, name + '.png')
        await dialog().screenshot({ path })
        const bytes = await readFile(path); entry.captures.push({ file: name + '.png', sha256: sha(bytes), bytes: bytes.length, target: 'actual acceptance dialog', containsBrowserURL: false })
      }
      const assertReview = async (result, expectedRows) => {
        assert.equal(result.status, 200); assert.equal(result.noStore, true)
        assert.deepEqual(result.request, { version: 1, quoteId: fixture.quoteA, optionId: null, portalToken: fixture.portalTokenA })
        const parsed = wire.parsePilotAcceptancePreview(result.body, result.request); assert.equal(parsed?.code, 'preview')
        const p = parsed.expected.offered.public; documentMatches(p, expectedRows, fixture)
        await dialog().getByRole('checkbox').waitFor({ state: 'visible' })
        assert.equal(await dialog().getByRole('checkbox').isChecked(), false); assert.equal(await primary().isEnabled(), false)
        const text = await dialog().innerText()
        for (const value of [p.customer_name, p.quote_number, p.address, p.service_type, p.notes, p.terms_text, p.company_name].filter(value => typeof value === 'string' && value.length)) assert.ok(text.includes(value), 'Native public text shown')
        assert.ok(text.includes('Amount being accepted: ' + money(p.accepted_amount)))
        assert.ok(text.includes('It does not make a payment.'))
        const lines = dialog().getByRole('list', { name: 'Quoted service and material lines', exact: true }).locator(':scope > li')
        assert.equal(await lines.count(), p.services.length)
        for (let index = 0; index < p.services.length; index++) {
          const line = p.services[index], shown = await lines.nth(index).innerText()
          for (const value of [line.service_type, String(line.quantity), money(line.unit_price), line.unit, line.notes].filter(Boolean)) assert.ok(shown.includes(value), 'Native service detail shown')
        }
        const included = await dialog().getByRole('region', { name: 'Included extras', exact: true }).innerText()
        const excluded = await dialog().getByRole('region', { name: 'Not included', exact: true }).innerText()
        for (const addon of p.addons) assert.ok((p.included_addon_ids.includes(addon.id) ? included : excluded).includes(addon.name + ' — ' + money(addon.price)))
        await privacy(); await geometry('fresh review')
        entry.evidence.push({ kind: 'fresh-native-review', previewSha256: sha(result.body), publicSha256: sha(p), previewRevision: parsed.expected.previewRevision,
          acceptedAmount: p.accepted_amount, initialPrice: p.initial_price, displayedServiceCount: p.services.length, termsInitiallyUnchecked: true, submissionBlocked: true })
        return parsed
      }
      const openReview = async expectedRows => {
        const launch = portal.page.getByRole('button', { name: /^Accept — / })
        await launch.waitFor({ state: 'visible' })
        const oldTerms = portal.page.getByRole('checkbox')
        assert.equal(await oldTerms.count(), 1, 'One actual Billing terms checkbox before modal')
        if (!(await oldTerms.isChecked())) await oldTerms.check()
        assert.equal(await launch.isEnabled(), true)
        const result = await observeAction('/api/acceptance/preview', () => launch.click())
        await dialog().waitFor({ state: 'visible' }); return assertReview(result, expectedRows)
      }
      const acknowledge = async () => {
        const checkbox = dialog().getByRole('checkbox'); await checkbox.check()
        assert.equal(await checkbox.isChecked(), true); assert.equal(await primary().isEnabled(), true)
      }
      const captureIntent = (result, expected) => {
        const r = result.request
        assert.deepEqual(r.expected, expected); assert.equal(r.portalToken, fixture.portalTokenA); assert.equal(r.quoteId, fixture.quoteA)
        assert.equal(r.optionId, null); assert.equal(r.reason, null); assert.equal(r.note, null); assert.equal(r.termsAck, true)
        assert.deepEqual(r.addonIds, expected.offered.public.included_addon_ids)
        assert.deepEqual(wire.buildPilotAcceptanceCommitRequest({ version: 1, quoteId: fixture.quoteA, optionId: null, portalToken: fixture.portalTokenA }, expected,
          { addonIds: r.addonIds, reason: null, note: null, termsAck: true, clientOperationId: r.clientOperationId }), r)
        return r
      }
      try {
        await check('actual portal loads and fresh native review requires separate terms assent', async () => {
          assert.equal(fixture.acceptanceVersioned, true); assert.equal(Object.keys(fixture.before.ownerA).length, 23)
          if (profileSlice) {
            entry.emailProfile = fixture.emailProfile
            entry.profileBefore = profileRows(fixture.before, fixture)
            report.limits.push(fixture.emailProfile === 'absent'
              ? 'This absent-profile run observes 21 installed business table families and two explicitly labelled empty placeholders for verified absent email relations.'
              : 'This present-profile run observes 23 business table families including one held workflow and its unstarted pending attempt; no email dispatch is exercised.')
          }
          assert.equal(fixture.before.ownerA.quote_acceptances.length, 0); assert.ok(fixture.termsA.trim())
          portal = await newPage('portal', viewport)
          const hydrated = portal.page.waitForResponse(response => new URL(response.url()).origin === baseURL && new URL(response.url()).pathname === '/api/payments/status')
          void hydrated.catch(() => {}) // Preserve rejection for await without an unhandled navigation-failure path.
          await portal.page.goto(baseURL + '/portal/' + encodeURIComponent(fixture.portalTokenA) + '?tab=billing&quote=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
          assert.equal((await hydrated).status(), 200) // This actual effect only runs after hydration.
          await portal.page.locator('#porttab-billing').click()
          assert.equal((await portal.context.cookies()).filter(authCookie).length, 0)
          preview = await openReview(fixture.before)
          assert.equal(counts('/api/acceptance/commit'), 0); assert.deepEqual(await rows(), fixture.before)
          assert.equal((await facts()).acceptanceCurrent, false)
          if (fixture.id === 'U1') await screenshot('U1-preview-terms-unchecked')
        })
        if (fixture.id === 'U2') {
          await check('actual authenticated owner Save changes scope and initial price while V1 stays open', async () => {
            await acknowledge()
            owner = await newPage('owner', { width: 1440, height: 1100 })
            await owner.page.goto(baseURL + '/login?quoteId=' + fixture.quoteA, { waitUntil: 'domcontentloaded' })
            await owner.page.waitForFunction(() => document.querySelector('[data-testid="login-ready"]')?.textContent === 'ready')
            await owner.page.getByLabel('Email', { exact: true }).fill(fixture.emailA); await owner.page.getByLabel('Password', { exact: true }).fill(fixture.password)
            await Promise.all([owner.page.waitForURL(url => url.origin === baseURL && url.pathname === '/quote' && url.searchParams.get('quoteId') === fixture.quoteA), owner.page.getByRole('button', { name: 'Sign in', exact: true }).click()])
            await owner.page.locator('textarea[name="notes"]').waitFor({ state: 'visible' }); assert.ok((await owner.context.cookies()).some(authCookie))
            await drain()
            const baseline = captured.findLast(item => item.path === '/api/baseline' && item.label === 'owner')
            assert.ok(baseline); assert.equal(baseline.status, 200); assert.equal(baseline.noStore, true)
            assert.equal(baseline.body.code, 'baseline'); assert.equal(baseline.body.ownerId, fixture.ownerA); assert.equal(baseline.body.quoteId, fixture.quoteA)
            assert.deepEqual(await rows(), fixture.before)
            await owner.page.locator('textarea[name="notes"]').fill(noteV2); await owner.page.locator('input[name="initial_price"]').fill(String(priceV2))
            assert.equal(await owner.page.locator('input[name="initial_price"]').evaluate(input => input.form.checkValidity()), true)
            const received = owner.page.waitForResponse(response => new URL(response.url()).origin === baseURL && new URL(response.url()).pathname === '/api/save' && response.request().method() === 'POST')
            const [response] = await Promise.all([received, owner.page.locator('button[type="submit"]:visible').click()]); await drain()
            const intent = response.request().postDataJSON(), result = captured.find(item => item.requestIdentity === response.request())
            assert.ok(result); assert.equal(result.status, 200); assert.equal(result.noStore, true)
            assert.equal(intent.expectedEditorRevision, baseline.body.editorRevision)
            const pending = { version: 1, owner: fixture.ownerA, quoteId: fixture.quoteA, clientOperationId: intent.clientOperationId,
              editorGeneration: intent.editorGeneration, originalEditorRevision: baseline.body.editorRevision, submittedValues: intent.values,
              submittedSerialization: JSON.stringify(intent.values), stagedAt: Date.now(), state: 'pending' }
            const receipt = wire.parsePilotQuoteSaveReceipt(result.body, pending); assert.equal(receipt?.code, 'committed')
            assert.equal(intent.values.notes, noteV2); assert.equal(intent.values.initial_price, priceV2)
            await owner.page.getByText('Submitted version saved', { exact: true }).waitFor({ state: 'visible' })
            for (const name of ['closed-count', 'reconciliation-count']) assert.equal((await owner.page.getByTestId(name).textContent())?.trim(), '0')
            preAcceptanceRows = await rows(); entry.evidence.push(savedPriceSideEffects(fixture.before, preAcceptanceRows, fixture))
            for (const [key, value] of Object.entries(receipt.quote)) assert.deepEqual(comparable(preAcceptanceRows.ownerA.quotes[0][key]), comparable(value), 'Save receipt/native quote ' + key)
            assert.deepEqual(comparable(preAcceptanceRows.ownerA.quote_services), comparable(receipt.services)); assert.deepEqual(preAcceptanceRows.ownerA.quote_services.map(row => row.sort_order), [0, 1, 2])
            assert.equal(receipt.acceptance_current, false)
            assert.equal(preAcceptanceRows.ownerA.quotes[0].notes, noteV2); assert.equal(preAcceptanceRows.ownerA.quotes[0].initial_price, priceV2)
            assert.equal(preAcceptanceRows.ownerA.quotes[0].status, 'sent'); assert.equal((await facts()).acceptanceCurrent, false)
            assert.equal((await dialog().innerText()).includes(noteV2), false, 'Open customer V1 must not silently rebase')
            assert.ok((await dialog().innerText()).includes('Amount being accepted: ' + money(preview.expected.offered.public.accepted_amount)))
            entry.afterSaveRows = preAcceptanceRows
            entry.evidence.push({ kind: 'real-owner-save', requestSha256: sha(intent), responseSha256: sha(result.body), operationId: intent.clientOperationId,
              notesChanged: true, initialPrice: priceV2, rowsSha256: sha(preAcceptanceRows), nativeValidationBypassed: false })
          })
          await check('stale click gives actual409 and visible refusal; explicit reopen requires fresh V2 assent', async () => {
            const stale = await observeAction('/api/acceptance/commit', () => primary().click()), intent = captureIntent(stale, preview.expected)
            assert.equal(stale.status, 409); assert.equal(stale.noStore, true)
            assert.deepEqual(stale.body, { code: 'refused', clientOperationId: intent.clientOperationId, previewRevision: intent.expected.previewRevision, reason: 'quote_changed' })
            assert.equal(wire.parsePilotAcceptanceCommitReply(stale.body, intent)?.code, 'refused')
            await dialog().getByRole('alert').filter({ hasText: 'The quote changed. Review the new version before accepting.' }).waitFor({ state: 'visible' })
            assert.equal(await primary().count(), 0); assert.equal((await dialog().innerText()).includes('Your acceptance is recorded.'), false)
            assert.deepEqual(await rows(), preAcceptanceRows); assert.equal(counts('/api/acceptance/commit'), 1); assert.equal(counts('/api/acceptance/reconcile'), 0)
            await screenshot('U2-stale-refusal')
            await dialog().getByRole('button', { name: 'Close', exact: true }).last().click(); await dialog().waitFor({ state: 'hidden' })
            const previous = preview; preview = await openReview(preAcceptanceRows)
            assert.notEqual(preview.expected.previewRevision, previous.expected.previewRevision)
            assert.equal(preview.expected.offered.public.notes, noteV2); assert.equal(preview.expected.offered.public.initial_price, priceV2)
            assert.notEqual(preview.expected.offered.public.accepted_amount, previous.expected.offered.public.accepted_amount)
            assert.equal(counts('/api/acceptance/commit'), 1); assert.deepEqual(await rows(), preAcceptanceRows)
            entry.evidence.push({ kind: 'stale-refusal-and-explicit-review', refusedStatus: stale.status, refusal: 'quote_changed', refusedRequestSha256: sha(intent), refusedResponseSha256: sha(stale.body),
              oldPreviewRevision: previous.expected.previewRevision, newPreviewRevision: preview.expected.previewRevision, noAcceptanceMutation: true, freshTermsInitiallyUnchecked: true })
          })
        }
        await check('explicit customer confirmation binds one genuine receipt to the displayed version and native ledger', async () => {
          await acknowledge()
          const result = await observeAction('/api/acceptance/commit', () => primary().click()), intent = captureIntent(result, preview.expected)
          acceptedResponseOrder = result.responseOrder
          assert.equal(result.status, 200); assert.equal(result.noStore, true)
          const parsed = wire.parsePilotAcceptanceCommitReply(result.body, intent); assert.equal(parsed?.code, 'accepted')
          await dialog().getByRole('status').filter({ hasText: 'Your acceptance is recorded.' }).waitFor({ state: 'visible' })
          assert.ok((await dialog().innerText()).includes('Recorded amount: ' + money(parsed.receipt.accepted_amount)))
          assert.equal(await primary().count(), 0); assert.equal(await dialog().getByRole('checkbox').count(), 0)
          finalRows = await rows(); finalFacts = await facts(); acceptedRows(preAcceptanceRows, finalRows, intent, parsed.receipt, fixture, finalFacts)
          if (fixture.id === 'U2') await screenshot('U2-recorded-acceptance')
          entry.evidence.push({ kind: 'actual-customer-acceptance', requestSha256: sha(intent), responseSha256: sha(result.body), operationId: intent.clientOperationId,
            previewRevision: intent.expected.previewRevision, acceptanceId: parsed.receipt.acceptance_id, acceptanceSeq: parsed.receipt.acceptance_seq,
            acceptedAmount: parsed.receipt.accepted_amount, actorKind: parsed.receipt.kind, source: parsed.receipt.source, rowsSha256: sha(finalRows), finalFacts })
        })
        await check('receipt-triggered actual portal refresh removes the stale action; fresh owner reads agree without replay', async () => {
          await dialog().getByRole('button', { name: 'Close', exact: true }).last().click(); await dialog().waitFor({ state: 'hidden' })
          // Approved is also a static journey-rail label. The actual launch
          // action disappearing is the observable completion of card refresh.
          await portal.page.getByRole('button', { name: /^Accept(?: |—)/ }).waitFor({ state: 'detached' })
          await portal.page.getByText('Approved', { exact: true }).first().waitFor({ state: 'visible' })
          assert.equal(await portal.page.getByRole('button', { name: /^Accept(?: |—)/ }).count(), 0)
          assert.ok(entry.requests.some(request => request.label === 'portal' && request.path === '/rest/v1/rpc/get_portal_data' && request.status === 200
            && request.order > acceptedResponseOrder), 'Real portal RPC refresh follows the actual acceptance response')
          const commitCount = fixture.id === 'U1' ? 1 : 2
          assert.equal(counts('/api/acceptance/commit'), commitCount); assert.equal(counts('/api/acceptance/reconcile'), 0)
          const fresh = await bounded(() => readFreshOwnerRows(fixture), 'Fresh real owner readback')
          assert.equal(fresh.ownerId, fixture.ownerA); assert.deepEqual(comparable(fresh.quote), comparable(finalRows.ownerA.quotes[0]))
          assert.deepEqual(comparable(fresh.services), comparable(finalRows.ownerA.quote_services))
          const hydrated = portal.page.waitForResponse(response => new URL(response.url()).origin === baseURL && new URL(response.url()).pathname === '/api/payments/status')
          void hydrated.catch(() => {})
          await portal.page.reload({ waitUntil: 'domcontentloaded' }); assert.equal((await hydrated).status(), 200)
          await portal.page.locator('#porttab-billing').click()
          await portal.page.getByText('Approved', { exact: true }).first().waitFor({ state: 'visible' })
          assert.equal(await portal.page.getByRole('button', { name: /^Accept(?: |—)/ }).count(), 0); assert.equal(await dialog().count(), 0)
          await drain(); await privacy(); assert.equal(counts('/api/acceptance/commit'), commitCount)
          assert.equal(counts('/api/acceptance/preview'), fixture.id === 'U1' ? 1 : 2); assert.equal(counts('/api/save'), fixture.id === 'U1' ? 0 : 1)
          assert.equal(counts('/api/acceptance/reconcile'), 0); assert.equal((await portal.context.cookies()).filter(authCookie).length, 0)
          assert.deepEqual(await rows(), finalRows); assert.deepEqual(await facts(), finalFacts)
          if (profileSlice) { entry.profileAfter = profileRows(finalRows, fixture); assert.deepEqual(entry.profileAfter, entry.profileBefore) }
          assert.ok(captured.every(item => item.noStore)); assert.equal(report.failures.some(f => f.case === fixture.id), false)
          if (outputDirectory) assert.equal(entry.captures.length, fixture.id === 'U1' ? 1 : 2)
          entry.evidence.push({ kind: 'fresh-readback-and-visible-refresh', freshQuoteSha256: sha(fresh.quote), freshServicesSha256: sha(fresh.services),
            browserSessionReused: false, approvedCardVisible: true, acceptActionAbsent: true, commitCount, automaticReplay: false })
          entry.afterRows = finalRows
        })
        successful = true
      } catch (error) {
        entry.error = { phase, message: safe(error) }
        try { entry.failureRowsBeforeCleanup = registerPrivateRows(await bounded(() => readRows(fixture), 'Failure state before cleanup', 5000)) } catch (failure) { entry.failureReadBefore = safe(failure) }
      } finally {
        for (const { context, observed } of contexts.reverse()) {
          try { await bounded(() => context.close(), 'Browser context close'); observed.closed = true } catch (error) { entry.cleanup.contextError = safe(error); successful = false }
        }
        try { await drain(); entry.cleanup.observationsDrained = true } catch (error) { entry.cleanup.observationError = safe(error); successful = false }
        entry.cleanup.contextsClosed = contexts.every(item => item.observed.closed)
        if (!successful || report.failures.some(f => f.case === fixture.id)) {
          try { entry.failureRowsAfterCleanup = registerPrivateRows(await bounded(() => readRows(fixture), 'Failure state after cleanup', 5000)) } catch (failure) { entry.failureReadAfter = safe(failure) }
          entry.cleanup.cancellationProvesRollback = false
        }
        entry.pass = successful && entry.phases.length === (fixture.id === 'U1' ? 3 : 5) && entry.phases.every(item => item.pass)
          && entry.cleanup.contextsClosed && entry.cleanup.observationsDrained && !report.failures.some(f => f.case === fixture.id)
        report.tests.push({ name: fixture.id + ' actual customer acceptance UI', pass: entry.pass, ...(entry.error ? { error: entry.error.message } : {}) })
      }
      if (!entry.pass) break
    }
    report.allOpenedContextsClosed = report.contexts.every(item => item.opened && item.closed)
    report.pass = report.tests.length === selectedCases.length && report.tests.every(test => test.pass) && report.allOpenedContextsClosed && report.failures.length === 0
  } catch (error) { report.error = safe(error); report.pass = false }
  registerPrivateRows(report)
  let output = JSON.stringify(report)
  for (const value of [...retainedSecrets].sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(value, '[private retained email value]').replaceAll(encodeURIComponent(value), '[private retained email value]')
  }
  try { assertPrivateAbsent(output) }
  catch (error) { return { pass: false, selectedCases: report.selectedCases, error: safe(error), evidenceWithheld: 'Report privacy assertion failed' } }
  return JSON.parse(output)
}
