// Actual config + compiled browser/server startup modules, with synthetic SDKs.
// Checks disabled startup, configured hooks and event/legacy INP route-name privacy.
// This does not measure the whole Next bundle or the real Sentry build wrapper.
// No application environment file, Sentry provider or network is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { buildSync, transformSync } from 'esbuild'
import ts from 'typescript'

type Environment = Record<string, string | undefined>
const configSource = readFileSync('next.config.ts', 'utf8')
const clientSource = readFileSync('instrumentation-client.ts', 'utf8')
const serverSource = readFileSync('instrumentation.ts', 'utf8')
const browserDsn = 'https://synthetic@example.invalid/1'
const compile = (source: string) => transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code

function configFor(env: Environment) {
  const testModule = { exports: {} as Record<string, any> }
  runInNewContext(compile(configSource), {
    module: testModule, process: { env }, require(id: string) {
      assert.equal(id, '@sentry/nextjs', 'config has no new runtime dependencies')
      return { withSentryConfig: (config: unknown) => config }
    },
  })
  return testModule.exports.default
}

function browserFor(env: Environment, initialize?: (options: Record<string, any>) => unknown) {
  const config = configFor(env)
  // Mirror Next's documented static env sources: present public variables and
  // next.config.env. An absent public variable is NOT automatically defined.
  const staticEnv = {
    ...Object.fromEntries(Object.entries(env).filter(([key, value]) => key.startsWith('NEXT_PUBLIC_') && value != null)),
    ...config.env,
  }
  const built = buildSync({
    stdin: { contents: clientSource, loader: 'ts', sourcefile: 'instrumentation-client.ts', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'browser', format: 'cjs', minify: true, target: 'es2022',
    external: ['@sentry/nextjs'],
    define: Object.fromEntries(Object.entries(staticEnv).map(([key, value]) => [`process.env.${key}`, JSON.stringify(value)])),
    logLevel: 'silent',
  }).outputFiles[0].text
  const sdkLoads: string[] = [], initializations: Record<string, any>[] = [], transitions: unknown[][] = []
  const testModule = { exports: {} as Record<string, any> }
  runInNewContext(built, {
    module: testModule, process: { env }, require(id: string) {
      assert.equal(id, '@sentry/nextjs', 'browser code can load only the synthetic SDK')
      sdkLoads.push(id)
      return {
        init: (options: Record<string, any>) => { initializations.push(options); return initialize?.(options) },
        captureRouterTransitionStart: (...args: unknown[]) => { transitions.push(args) },
      }
    },
  })
  return { config, built, sdkLoads, initializations, transitions, hook: testModule.exports.onRouterTransitionStart }
}

async function serverFor(env: Environment) {
  const built = buildSync({
    stdin: { contents: serverSource, loader: 'ts', sourcefile: 'instrumentation.ts', resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022',
    external: ['@sentry/nextjs'], logLevel: 'silent',
  }).outputFiles[0].text
  const initializations: Record<string, any>[] = []
  const captureRequestError = () => { throw new Error('Real error reporting is forbidden in this guard') }
  const testModule = { exports: {} as Record<string, any> }
  runInNewContext(built, {
    module: testModule, process: { env }, fetch: () => assert.fail('Network is forbidden'),
    require(id: string) {
      assert.equal(id, '@sentry/nextjs', 'server code can load only the synthetic SDK')
      return { init: (options: Record<string, any>) => { initializations.push(options) }, captureRequestError }
    },
  })
  await testModule.exports.register()
  assert.equal(testModule.exports.onRequestError, captureRequestError, 'request-error forwarding remains the SDK hook')
  return initializations
}

// Read the installed SDK's actual header constructor without executing its
// imports, initializing a client or creating a transport. This is the boundary
// that copies dynamicSamplingContext into the envelope, outside the event body.
const envelopeSource = ts.createSourceFile('envelope.js',
  readFileSync(join(dirname(require.resolve('@sentry/core')), 'utils/envelope.js'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const headerFunction = envelopeSource.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createEventEnvelopeHeaders')
assert.ok(headerFunction, 'installed SDK must retain a reviewable event-envelope header boundary')
const envelopeHeaders = runInNewContext(`(${headerFunction.getText(envelopeSource)})`, {
  randomSafeContext: { safeDateNow: () => 1_700_000_000_000 },
  dsn: { dsnToString: () => assert.fail('No DSN or tunnel is used in the envelope fixture') },
}) as (event: Record<string, any>) => Record<string, any>

// Extract SDK boundaries as code, never execute SDK imports or initialize a real
// client. Span fixtures are synthetic; the independent INP proof covers the real
// metric producer. This guard owns registration timing and final serialization.
function sdkSource(pkg: string, relative: string) {
  const file = join(dirname(require.resolve(pkg)), relative)
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}
function sdkFunction(source: ts.SourceFile, name: string, context: Record<string, unknown> = {}) {
  let found: ts.FunctionDeclaration | ts.MethodDeclaration | ts.VariableDeclaration | undefined
  function walk(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name?.getText(source) === name) found = node
    ts.forEachChild(node, walk)
  }
  walk(source)
  assert.ok(found, `SDK boundary ${name} must remain reviewable`)
  const expression = ts.isMethodDeclaration(found) ? `({${found.getText(source)}}).${name}` :
    ts.isVariableDeclaration(found) ? found.initializer!.getText(source) : `(${found.getText(source)})`
  return runInNewContext(expression, { Uint8Array, ...context,
    require: () => assert.fail('SDK imports are forbidden'), fetch: () => assert.fail('Network is forbidden') })
}

function verifyInpEnvelopes() {
  const core = (file: string) => sdkSource('@sentry/core', file)
  const utilities = core('utils/envelope.js'), integration = core('integration.js'), clientSource = core('client.js')
  const envelope = Object.fromEntries(['createEnvelope', 'createSpanEnvelopeItem'].map(name => [name, sdkFunction(utilities, name)]))
  const serialize = sdkFunction(utilities, 'serializeEnvelope', {
    encodeUTF8: (text: string) => new TextEncoder().encode(text), concatBuffers: sdkFunction(utilities, 'concatBuffers'),
    normalize: { normalize: () => assert.fail('Cyclic fixtures are unexpected') },
  })
  const createSpanEnvelope = sdkFunction(core('envelope.js'), 'createSpanEnvelope', {
    dynamicSamplingContext: { getDynamicSamplingContextFromSpan: (span: any) => span.sampling },
    spanUtils: { spanToJSON: (span: any) => span.json }, envelope,
    beforeSendSpan: { isStreamedBeforeSendSpanCallback: sdkFunction(core('tracing/spans/beforeSendSpan.js'), 'isStreamedBeforeSendSpanCallback') },
    randomSafeContext: { safeDateNow: () => 1_700_000_000_000 },
    dsn: { dsnToString: () => assert.fail('No tunnel is used') },
    shouldIgnoreSpan: { shouldIgnoreSpan: () => assert.fail('No ignore policy is changed') },
  })
  const getIntegrations = sdkFunction(integration, 'getIntegrationsToSetup', { filterDuplicates: sdkFunction(integration, 'filterDuplicates') })
  const setupIntegration = sdkFunction(integration, 'setupIntegration', { installedIntegrations: [], debugBuild: { DEBUG_BUILD: false } })
  const setupIntegrations = sdkFunction(integration, 'setupIntegrations', { setupIntegration })
  const afterSetupIntegrations = sdkFunction(integration, 'afterSetupIntegrations')
  const sendEnvelope = sdkFunction(clientSource, 'sendEnvelope', { debugBuild: { DEBUG_BUILD: false } })
  let options: Record<string, any> = {}, duringInit = false, cachedDuringInit = false, transportCalls = 0
  const outputs: (string | Uint8Array)[] = []
  const client: Record<string, any> = {
    _hooks: {}, _integrations: {}, getOptions: () => options, getDsn: () => undefined,
    on: sdkFunction(clientSource, 'on'), emit: sdkFunction(clientSource, 'emit'), _isEnabled: () => false,
    _transport: { send: () => { transportCalls++; assert.fail('Even synthetic transport calls are forbidden') } },
    addIntegration: sdkFunction(clientSource, 'addIntegration', { integration: { setupIntegration, afterSetupIntegrations } }),
    getIntegrationByName(name: string) { return this._integrations[name] },
  }
  function send(value: any) {
    // The actual disabled client still emits beforeEnvelope synchronously. Do
    // not call transport.send; serialize its resulting envelope separately.
    void sendEnvelope.call(client, value)
    const serialized = serialize(value) as string | Uint8Array
    outputs.push(serialized)
    return serialized
  }
  const fixture = (body = '/portal/private-inp', header = '/book/private-sampling') => ({
    sampling: Object.freeze({ transaction: header, trace_id: 'synthetic-trace', public_key: 'synthetic-public', sampled: 'true' }),
    json: Object.freeze({ origin: 'auto.http.browser.inp', span_id: 'synthetic-span', trace_id: 'synthetic-trace',
      start_timestamp: 1, timestamp: 2, description: 'button.save', op: 'ui.interaction.click',
      data: Object.freeze({ transaction: body, retained: 42 }), measurements: { inp: { value: 120, unit: 'millisecond' } } }),
  })
  const cached = fixture()
  // Use the actual BrowserTracing afterAllSetup installation branch and actual
  // WebVitals.setup. Its INP observer callback supplies a synthetic cached span.
  const tracing = sdkSource('@sentry/browser', 'tracing/browserTracingIntegration.js')
  let installBranch: ts.IfStatement | undefined
  function findBranch(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(tracing).startsWith('client.addIntegration &&')) installBranch = node
    ts.forEachChild(node, findBranch)
  }
  findBranch(tracing)
  assert.ok(installBranch, 'BrowserTracing must retain a reviewable WebVitals installation phase')
  const webVitalsIntegration = sdkFunction(sdkSource('@sentry/browser', 'integrations/webVitals.js'), 'webVitalsIntegration', {
    WEB_VITALS_INTEGRATION_NAME: 'WebVitals', browser: { defineIntegration: (factory: unknown) => factory, hasSpanStreamingEnabled: () => false },
    browserUtils: { startTrackingWebVitals: () => () => {}, registerInpInteractionListener() {},
      startTrackingINP() { cachedDuringInit = duringInit; send(createSpanEnvelope([cached], client)) } },
  })
  const defaultIntegration = { name: 'SyntheticBrowserTracing', afterAllSetup: runInNewContext(`(client) => {${installBranch.getText(tracing)}}`, {
    webVitals: { WEB_VITALS_INTEGRATION_NAME: 'WebVitals', webVitalsIntegration },
    enableInp: true, enableStandaloneClsSpans: undefined, enableStandaloneLcpSpans: undefined,
  }) }
  browserFor({ NEXT_PUBLIC_SENTRY_DSN: browserDsn }, configured => {
    options = configured; duringInit = true
    const integrations = getIntegrations({ ...options, defaultIntegrations: [defaultIntegration] })
    client._integrations = setupIntegrations(client, integrations)
    afterSetupIntegrations(client, integrations)
    duringInit = false
    return client
  })
  check('INP: cached WebVitals setup has privacy hooks before init returns; defaults survive', () => {
    assert.ok(cachedDuringInit)
    assert.equal(outputs.length, 1)
    assert.ok(typeof outputs[0] === 'string')
    assert.doesNotMatch(outputs[0], /private-/)
    assert.equal(client.getIntegrationByName(defaultIntegration.name), defaultIntegration)
    assert.ok(client.getIntegrationByName('WebVitals'))
  })
  check('INP: final serialized body/header names are independent; frozen SDK state is retained', () => {
    for (const name of ['/portal/private-route', 'GET /book/private-route?code=private-query', 'Label&code=private-prefix (/book/private-route)', '/portal/[token]', '/dashboard']) {
      const span = fixture(name, name), value = createSpanEnvelope([span], client)
      const serialized = send(value)
      assert.ok(typeof serialized === 'string')
      assert.doesNotMatch(serialized, /private-/)
      assert.equal(span.json.data.transaction, name)
      assert.equal(span.sampling.transaction, name)
      assert.equal(value[1][0][1].description, span.json.description)
      assert.equal(value[1][0][1].measurements, span.json.measurements)
      assert.equal(value[1][0][1].data.retained, 42)
      assert.equal(value[0].trace.public_key, span.sampling.public_key)
      if (!name.includes('private-')) {
        assert.equal(value[1][0][1].data.transaction, name)
        assert.equal(value[0].trace.transaction, name)
      }
    }
  })
  check('INP: non-INP, streamed, string, binary and unknown items remain untouched', () => {
    for (const item of [
      [{ type: 'span' }, { ...cached.json, origin: 'auto.http.browser.lcp' }],
      [{ type: 'span', content_type: 'application/vnd.sentry.items.span.v2+json' }, cached.json],
      [{ type: 'span' }, { origin: 'auto.http.browser.inp', data: cached.json.data }],
      [{ type: 'span' }, JSON.stringify(cached.json)], [{ type: 'span' }, new Uint8Array([1, 2])],
      [{ type: 'transaction' }, { spans: [cached.json] }],
    ]) {
      const headers = Object.freeze({ trace: cached.sampling })
      const value: [unknown, unknown[]] = [headers, [item]]
      const before = serialize(value)
      assert.deepEqual(send(value), before)
      assert.equal(value[0], headers)
      assert.equal(value[1][0], item)
    }
    assert.equal(transportCalls, 0)
  })
}

let passed = 0
function check(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`) }

function verifyTransactionNames(options: Record<string, any>, runtime: string) {
  const names = [
    ['/portal/private-name', '/portal/[token]'],
    ['/book/private-booking-name', '/book/[token]'],
    ['GET /portal/private-method?token=private-query&view=week', 'GET /portal/[token]?token=[redacted]&view=week'],
    ['https://fixture.invalid/book/private-absolute?code=private-code#details', 'https://fixture.invalid/book/[token]?code=[redacted]#details'],
    ['Page Server Component (/portal/private-component)', 'Page Server Component (/portal/[token])'],
    ['handler (/book/private-handler?signature=private-signature)', 'handler (/book/[token]?signature=[redacted])'],
    ['/portal/[token]', '/portal/[token]'],
    ['GET /book/[token]', 'GET /book/[token]'],
    ['Page Server Component (/portal/[token])', 'Page Server Component (/portal/[token])'],
    ['GET /dashboard?view=week', 'GET /dashboard?view=week'],
    ['', ''],
  ]
  for (const hook of ['beforeSend', 'beforeSendTransaction']) {
    check(`${runtime} ${hook}: route names and envelope copies are scrubbed; safe names retain their identity`, () => {
      for (const [input, expected] of names) {
        const sampling = Object.freeze({ transaction: input, trace_id: 'synthetic-trace', public_key: 'synthetic-public', sampled: 'true', sample_rate: '0.1' })
        const retained = { spanCountBeforeProcessing: 3 }
        const metadata = Object.freeze({ dynamicSamplingContext: sampling, retained })
        const event = { type: hook === 'beforeSendTransaction' ? 'transaction' : undefined,
          message: 'synthetic error', transaction: input, sdkProcessingMetadata: metadata }
        const clean = options[hook](event, {})
        assert.equal(clean, event, 'scrubbing returns the same event rather than dropping useful telemetry')
        assert.equal(clean.transaction, expected)
        const headers = envelopeHeaders(clean)
        assert.equal(headers.trace.transaction, expected, 'the envelope trace must not retain a second private name')
        assert.doesNotMatch(JSON.stringify({ transaction: clean.transaction, trace: headers.trace }), /private-/)
        assert.equal(headers.trace.trace_id, sampling.trace_id)
        assert.equal(headers.trace.public_key, sampling.public_key)
        assert.equal(headers.trace.sampled, sampling.sampled)
        assert.equal(headers.trace.sample_rate, sampling.sample_rate)
        assert.equal(clean.sdkProcessingMetadata.retained, retained)
        assert.equal(sampling.transaction, input, 'SDK-shared sampling metadata must not be mutated')
        assert.equal(options[hook](clean, {}).transaction, expected, 'name scrubbing is idempotent')
      }
    })
    check(`${runtime} ${hook}: name copies are independent and absent names stay absent`, () => {
      const clean = options[hook]({ transaction: '/dashboard', sdkProcessingMetadata: {
        dynamicSamplingContext: { transaction: '/book/private-independent' },
      } }, {})
      assert.equal(clean.transaction, '/dashboard')
      assert.equal(envelopeHeaders(clean).trace.transaction, '/book/[token]')
      const withoutName = options[hook]({ extra: { note: 'safe' } }, {})
      assert.equal(Object.hasOwn(withoutName, 'transaction'), false)
      assert.equal(Object.hasOwn(withoutName, 'sdkProcessingMetadata'), false)
    })
    check(`${runtime} ${hook}: a sensitive prefix cannot bypass scrubbing via a wrapper suffix`, () => {
      for (const input of ['/portal/private-prefix (/book/private-suffix)', 'label?code=private-prefix (/book/private-suffix)', 'label&code=private-prefix (/book/private-suffix)']) {
        const clean = options[hook]({ transaction: input, sdkProcessingMetadata: { dynamicSamplingContext: { transaction: input } } }, {})
        assert.doesNotMatch(JSON.stringify({ transaction: clean.transaction, trace: envelopeHeaders(clean).trace }), /private-/)
      }
    })
  }
}

for (const [name, env] of [
  ['absent browser DSN', {}],
  ['empty browser DSN', { NEXT_PUBLIC_SENTRY_DSN: '' }],
  ['server DSN only', { SENTRY_DSN: 'https://synthetic-server@example.invalid/2' }],
  ['source-map token only', { SENTRY_AUTH_TOKEN: 'synthetic-source-map-token' }],
] as [string, Environment][]) {
  check(`${name}: no SDK load, init or navigation work`, () => {
    const browser = browserFor(env)
    assert.equal(browser.sdkLoads.length, 0, 'disabled browser monitoring must not require the SDK')
    assert.equal(browser.initializations.length, 0)
    assert.equal(typeof browser.hook, 'function', 'Next always receives a callable hook')
    browser.hook('/dashboard', 'push')
    assert.equal(browser.transitions.length, 0)
    assert.doesNotMatch(browser.built, /@sentry\/nextjs/, 'disabled compilation removes the SDK dependency entirely')
  })
  check(`${name}: configuration provides an explicit empty public compile-time value only`, () => {
    const config = configFor(env)
    assert.deepEqual(Object.keys(config.env), ['NEXT_PUBLIC_SENTRY_DSN'])
    assert.equal(config.env.NEXT_PUBLIC_SENTRY_DSN, '')
    assert.ok(!JSON.stringify(config.env).includes('synthetic-source-map-token'))
    assert.ok(!JSON.stringify(config.env).includes('synthetic-server'))
  })
}

for (const deployment of ['production', 'preview', undefined]) {
  check(`${deployment ?? 'local'}: configured startup is synchronous and forwards router arguments`, () => {
    const browser = browserFor({ NEXT_PUBLIC_SENTRY_DSN: browserDsn, NEXT_PUBLIC_VERCEL_ENV: deployment,
      NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: 'synthetic-release' })
    assert.equal(browser.config.env.NEXT_PUBLIC_SENTRY_DSN, browserDsn)
    assert.equal(browser.sdkLoads.length, 1)
    assert.equal(browser.initializations.length, 1, 'init must finish during module evaluation, before hydration')
    const options = browser.initializations[0]
    assert.equal(options.dsn, browserDsn)
    assert.equal(options.environment, deployment ?? 'development')
    assert.equal(options.release, 'synthetic-release')
    assert.equal(options.tracesSampleRate, deployment === 'production' ? 0.1 : 0)
    for (const navigation of ['push', 'replace', 'traverse']) browser.hook('/dashboard?view=week', navigation)
    assert.deepEqual(browser.transitions, ['push', 'replace', 'traverse'].map(n => ['/dashboard?view=week', n]))
  })
}

check('configured privacy options and existing request/breadcrumb scrubbing survive the loading change', () => {
  const { initializations } = browserFor({ NEXT_PUBLIC_SENTRY_DSN: browserDsn })
  const options = initializations[0]
  assert.equal(options.sendDefaultPii, false)
  assert.equal(options.sampleRate, 1)
  assert.equal(options.replaysSessionSampleRate, 0)
  assert.equal(options.replaysOnErrorSampleRate, 0)
  assert.ok(options.ignoreErrors.includes('chrome-extension://'))
  assert.ok(options.ignoreErrors.includes('Failed to fetch'))
  assert.equal(options.beforeSend({ message: 'NEXT_REDIRECT: synthetic control flow' }), null)
  const event = { message: 'synthetic error', request: { url: 'https://fixture.invalid/portal/private-portal?token=private-token' },
    extra: { password: 'private-password' } }
  const clean = options.beforeSend(event)
  assert.ok(clean)
  assert.doesNotMatch(JSON.stringify(clean), /private-portal|private-token|private-password/)
  assert.match(JSON.stringify(clean), /\[token\]|\[redacted\]/)
  const transaction = options.beforeSendTransaction({ transaction: '/book/private-booking', request: { url: 'https://fixture.invalid/book/private-booking' } })
  assert.doesNotMatch(JSON.stringify(transaction), /private-booking/)
  const crumb = options.beforeBreadcrumb({ data: { url: 'https://fixture.invalid/portal/private-crumb' } })
  assert.doesNotMatch(JSON.stringify(crumb), /private-crumb/)
})

verifyTransactionNames(browserFor({ NEXT_PUBLIC_SENTRY_DSN: browserDsn }).initializations[0], 'browser')
verifyInpEnvelopes()

async function verifyServerMonitoring() {
  for (const runtime of ['nodejs', 'edge']) {
    for (const env of [{}, { SENTRY_DSN: '' }, { NEXT_PUBLIC_SENTRY_DSN: browserDsn }, { SENTRY_AUTH_TOKEN: 'synthetic-source-map-token' }]) {
      const options = await serverFor({ ...env, NEXT_RUNTIME: runtime })
      check(`${runtime}: absent server DSN never initializes monitoring`, () => assert.equal(options.length, 0))
    }
    for (const deployment of ['production', 'preview', undefined]) {
      const options = await serverFor({ SENTRY_DSN: browserDsn, NEXT_RUNTIME: runtime,
        VERCEL_ENV: deployment, VERCEL_GIT_COMMIT_SHA: 'synthetic-server-release' })
      check(`${runtime} ${deployment ?? 'local'}: configured registration preserves privacy and sampling options`, () => {
        assert.equal(options.length, 1)
        assert.equal(options[0].dsn, browserDsn)
        assert.equal(options[0].environment, deployment ?? 'development')
        assert.equal(options[0].release, 'synthetic-server-release')
        assert.equal(options[0].sendDefaultPii, false)
        assert.equal(options[0].sampleRate, 1)
        assert.equal(options[0].tracesSampleRate, deployment === 'production' ? 0.1 : 0)
        assert.equal(options[0].beforeSend({ message: 'NEXT_REDIRECT: synthetic control flow' }, {}), null)
        const clean = options[0].beforeSend({ request: { url: '/portal/private-server', headers: { authorization: 'private-header' } },
          breadcrumbs: [{ message: '/book/private-crumb' }], extra: { password: 'private-password' } }, {})
        assert.doesNotMatch(JSON.stringify(clean), /private-/)
      })
      if (deployment === 'production') verifyTransactionNames(options[0], runtime)
    }
  }
  const unknownRuntime = await serverFor({ SENTRY_DSN: browserDsn, NEXT_RUNTIME: 'synthetic-unknown' })
  check('unknown runtime does not implicitly activate monitoring', () => assert.equal(unknownRuntime.length, 0))
}

verifyServerMonitoring().then(() => {
  console.log(`Monitoring: ${passed} passed, 0 failed. Actual startup hooks and SDK envelope/lifecycle boundaries; synthetic SDKs only.`)
}).catch(error => { console.error(error); process.exitCode = 1 })
