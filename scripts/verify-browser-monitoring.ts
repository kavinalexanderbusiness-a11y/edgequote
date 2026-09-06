// Actual config + compiled browser startup module, with a synthetic SDK only.
// Checks removal from this startup module and configured startup/navigation.
// This does not measure the whole Next bundle or the real Sentry build wrapper.
// No application environment file, Sentry provider or network is used.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync, transformSync } from 'esbuild'

type Environment = Record<string, string | undefined>
const configSource = readFileSync('next.config.ts', 'utf8')
const clientSource = readFileSync('instrumentation-client.ts', 'utf8')
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

function browserFor(env: Environment) {
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
        init: (options: Record<string, any>) => { initializations.push(options) },
        captureRouterTransitionStart: (...args: unknown[]) => { transitions.push(args) },
      }
    },
  })
  return { config, built, sdkLoads, initializations, transitions, hook: testModule.exports.onRouterTransitionStart }
}

let passed = 0
function check(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`) }

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
  // Existing scrubEvent handles request URLs; transaction-name scrubbing is a
  // separate known gap. Do not mistake this loading regression for full coverage.
  assert.doesNotMatch(transaction.request.url, /private-booking/)
  const crumb = options.beforeBreadcrumb({ data: { url: 'https://fixture.invalid/portal/private-crumb' } })
  assert.doesNotMatch(JSON.stringify(crumb), /private-crumb/)
})

console.log(`Browser monitoring: ${passed} passed, 0 failed. Compiled startup module only; synthetic SDK and config wrapper.`)
