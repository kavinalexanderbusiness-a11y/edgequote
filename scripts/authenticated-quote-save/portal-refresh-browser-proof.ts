import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { acceptanceCallerFixture, acceptanceCallerOwner } from '../pilot-email/acceptance-caller-fixtures'
import { runAcceptanceCallerMountedCases, acceptanceCallerMountedHarnessEvidence } from '../pilot-email/acceptance-caller-mounted-cases'

// Explicit focused synthetic React proof. No historical native packet is
// consumed and no predecessor suite, app server or database is started.
const output = resolve('outputs/quote-acceptance-ui-20260911/portal-refresh-proof.json')
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const files = [
  'scripts/authenticated-quote-save/portal-refresh-browser-proof.ts',
  'scripts/authenticated-quote-save/portal-refresh-mounted-fixture.ts',
  'scripts/pilot-email/acceptance-caller-fixtures.ts',
  'scripts/pilot-email/acceptance-caller-mounted-cases.ts',
  'scripts/pilot-email/quote-save-caller-cases.ts',
  'src/app/portal/[token]/PortalClient.tsx',
]
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(), pass: false, selection: 'portal-refresh',
  scope: 'Five actual PortalClient/React/controller refresh regressions using synthetic acceptance receipts and auxiliary I/O.',
  exclusions: ['No real Auth/PostgREST or native COMMIT proof', 'No historical source-bound packet requirement or broad suite rerun',
    'No production app, database or provider writes'],
}
async function main() {
try {
  const chrome = process.argv[2]
  assert.ok(chrome && isAbsolute(chrome) && existsSync(chrome), 'Existing absolute isolated Chrome executable required')
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  report.candidate = candidate
  report.tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  if (process.env.GITHUB_ACTIONS === 'true') assert.equal(candidate, process.env.GITHUB_SHA)
  const sourcePins = Object.fromEntries(files.map(file => [file, sha(readFileSync(file))]))
  report.sourcePins = sourcePins
  const seed = acceptanceCallerFixture(true)
  const responseFixtures = [{ mode: 'portal', ownerId: acceptanceCallerOwner, quoteId: seed.request.quoteId, optionId: seed.request.optionId,
    previewResponse: { code: 'preview', expected: seed.expected },
    commitResponse: { code: 'accepted', clientOperationId: seed.choice.clientOperationId, previewRevision: seed.expected.previewRevision, receipt: seed.receipt } }]
  const provenance = { kind: 'synthetic-local' as const, fixtureSourcePins: {
    'scripts/pilot-email/acceptance-caller-fixtures.ts': sourcePins['scripts/pilot-email/acceptance-caller-fixtures.ts'],
    'scripts/authenticated-quote-save/portal-refresh-mounted-fixture.ts': sourcePins['scripts/authenticated-quote-save/portal-refresh-mounted-fixture.ts'],
  } }
  report.provenance = provenance
  report.fixtureSha256 = sha(JSON.stringify(responseFixtures))
  const tests = await runAcceptanceCallerMountedCases(responseFixtures, provenance, chrome, 'portal-refresh')
  report.tests = tests
  report.passed = tests.filter(test => test.pass).length
  report.failed = tests.filter(test => !test.pass).length
  assert.equal(tests.length, 5, 'Only the five bounded refresh cases must run')
  assert.ok(tests.every(test => test.pass), 'Focused portal refresh regression failed')
  const browser = acceptanceCallerMountedHarnessEvidence.browser as Record<string, unknown>
  assert.equal(browser.childClosed, true)
  assert.equal(browser.profileRemoved, true)
  assert.deepEqual(browser.cleanupErrors, [])
  const fixture = browser.fixture as { allRootsUnmounted?: boolean; unhandled?: unknown[]; blocked?: unknown[]; commits?: unknown[] }
  assert.equal(fixture.allRootsUnmounted, true)
  assert.deepEqual(fixture.unhandled, [])
  assert.deepEqual(fixture.blocked, [])
  assert.equal(fixture.commits?.length, 5, 'Exactly one explicit acceptance per focused case')
  for (const [file, pin] of Object.entries(sourcePins)) assert.equal(sha(readFileSync(file)), pin, 'Proof source changed: ' + file)
  report.sourceUnchanged = true
  report.pass = true
} catch (error) {
  report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Focused refresh proof failed'
} finally {
  report.browserHarness = acceptanceCallerMountedHarnessEvidence
  report.completedAt = new Date().toISOString()
  mkdirSync(resolve('outputs/quote-acceptance-ui-20260911'), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, passed: report.passed, failed: report.failed, error: report.error, output }))
  if (report.pass !== true) process.exitCode = 1
}
}
void main()
