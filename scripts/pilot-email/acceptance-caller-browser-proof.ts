import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runAcceptanceCallerMountedCases, acceptanceCallerMountedHarnessEvidence } from './acceptance-caller-mounted-cases'

const output = resolve('outputs/pilot-full-quote-save-20260910')
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const required = [
  'scripts/pilot-email/acceptance-caller-browser-proof.ts', 'scripts/pilot-email/acceptance-caller-mounted-cases.ts',
  'scripts/pilot-email/acceptance-caller-mounted-fixture.ts', 'scripts/pilot-email/acceptance-caller-native-cases.ts',
  'scripts/pilot-email/acceptance-caller-server-cases.ts', 'scripts/pilot-email/acceptance-caller-fixtures.ts',
  'scripts/pilot-email/quote-save-server-proof.ts', 'scripts/pilot-email/quote-save-caller-cases.ts',
  'src/lib/quotes/pilotQuoteAcceptance.ts', 'src/lib/quotes/pilotQuoteAcceptanceServer.ts',
  'src/hooks/usePilotQuoteAcceptance.ts', 'src/components/quotes/PilotQuoteAcceptanceModal.tsx',
  'src/components/quotes/RecordAcceptanceDialog.tsx', 'src/app/portal/[token]/PortalClient.tsx',
  'supabase/proposals/pilot-quote-versioned-acceptance.sql', 'supabase/proposals/pilot-quote-acceptance-callers-contract.md',
]

async function main() {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), pass: false, mountedRoute: false,
    productionCalls: 0, externalProviderCalls: 0,
    scope: 'Actual portal and owner acceptance callers with dormant Save in isolated Chrome. Exact sanitized native HTTP response captures plus separately identified synthetic faults/lifecycles. Synthetic Auth/transport; no live app, browser-to-database or durable outer-COMMIT claim.',
  }
  try {
    const chrome = process.argv[2]
    if (!chrome || !existsSync(chrome)) throw new Error('An existing isolated Chrome executable is required; no install or skip fallback')
    const nativeBytes = readFileSync(join(output, 'native-pg17-proof.json'))
    const serverBytes = readFileSync(join(output, 'server-save-proof.json'))
    const native = JSON.parse(nativeBytes.toString('utf8')), server = JSON.parse(serverBytes.toString('utf8'))
    for (const [name, proof] of [['native', native], ['server', server]] as const) {
      assert.equal(proof.pass, true, name + ' proof must pass')
      assert.equal(proof.failed, 0)
      assert.equal(proof.allSessionsClosed, true)
      assert.equal(proof.productionCalls, 0)
      assert.ok(proof.sourcePins && Object.keys(proof.sourcePins).length > 0)
      for (const [file, hash] of Object.entries(proof.sourcePins))
        assert.equal(sha(readFileSync(resolve(file), 'utf8').replace(/\r\n/g, '\n')), hash, name + ' source changed: ' + file)
      for (const file of required) assert.ok(Object.hasOwn(proof.sourcePins, file), 'Missing ' + name + ' source pin: ' + file)
    }
    const nativeProofSha256 = sha(nativeBytes), serverProofSha256 = sha(serverBytes)
    assert.equal(server.consumedNativeProofSha256, nativeProofSha256)
    assert.deepEqual(server.sourcePins, native.sourcePins)
    assert.equal(server.acceptance.length, 13)
    assert.ok(server.acceptance.every((test: { pass: boolean }) => test.pass))
    assert.equal(server.acceptanceNative.length, 6)
    assert.ok(server.acceptanceNative.every((test: { pass: boolean }) => test.pass))
    assert.equal(server.acceptanceResponseFixtures.length, 4)
    assert.equal(server.acceptanceResponseFixturesSha256, sha(JSON.stringify(server.acceptanceResponseFixtures)))
    assert.deepEqual(server.acceptanceResponseFixtures.map((f: { name: string }) => f.name).sort(),
      ['owner-options', 'owner-plain', 'portal-no_charge', 'portal-services'])
    for (const fixture of server.acceptanceResponseFixtures) {
      const evidence = server.acceptanceNativeEvidence.find((item: { name: string }) => item.name === fixture.name)
      assert.ok(evidence)
      assert.equal(evidence.previewZeroWrites, true)
      assert.equal(evidence.nativeWriteCount, 1)
      assert.equal(evidence.durableOuterCommitProved, false)
      assert.equal(evidence.previewResponseSha256, sha(JSON.stringify(fixture.previewResponse)))
      assert.equal(evidence.commitResponseSha256, sha(JSON.stringify(fixture.commitResponse)))
    }
    report.sourcePins = native.sourcePins
    report.consumedNativeProofSha256 = nativeProofSha256
    report.consumedServerProofSha256 = serverProofSha256
    report.responseFixturesSha256 = server.acceptanceResponseFixturesSha256
    const tests = await runAcceptanceCallerMountedCases(server.acceptanceResponseFixtures,
      { kind: 'native-http-capture', nativeProofSha256, serverProofSha256 }, chrome)
    report.tests = tests
    report.passed = tests.filter(test => test.pass).length
    report.failed = tests.filter(test => !test.pass).length
    report.pass = tests.length > 0 && tests.every(test => test.pass)
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Acceptance caller browser proof failed'
  } finally {
    report.browserHarness = acceptanceCallerMountedHarnessEvidence
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'browser-acceptance-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
