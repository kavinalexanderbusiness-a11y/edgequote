import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DisposableSession, type TestResult } from './database'
import { runQuoteSaveServerCases, quoteSaveServerEvidence } from './quote-save-server-cases'
import { runQuoteSaveServerNativeCases, quoteSaveServerNativeEvidence } from './quote-save-server-native-cases'

const output = resolve('outputs/pilot-full-quote-save-20260910')
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')

async function main() {
  let db: DisposableSession | undefined
  let openAttempted = false, openCompleted = false
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), pass: false,
    scope: 'Actual dormant HTTP adapter and planner with synthetic verified auth; service-role SQL transport on the same marked PostgreSQL17 fixture. No mounted app, live Auth or PostgREST transport E2E.',
    mountedRoute: false, productionCalls: 0, externalProviderCalls: 0,
  }
  try {
    // This phase may consume only the just-proved schema from identical source.
    // DisposableSession separately checks target, server version and DB marker.
    const bytes = readFileSync(join(output, 'native-pg17-proof.json'))
    const native = JSON.parse(bytes.toString('utf8'))
    assert.equal(native.pass, true)
    assert.equal(native.failed, 0)
    assert.equal(native.allSessionsClosed, true)
    assert.equal(native.candidateFullSaveImplemented, true)
    assert.equal(native.mountedFullSaveImplemented, false)
    assert.equal(native.productionCalls, 0)
    assert.ok(native.sourcePins && typeof native.sourcePins === 'object')
    assert.ok(Object.keys(native.sourcePins).length > 0)
    for (const [file, hash] of Object.entries(native.sourcePins)) {
      assert.equal(sha(readFileSync(resolve(file), 'utf8').replace(/\r\n/g, '\n')), hash, 'Schema source changed: ' + file)
    }
    for (const file of ['scripts/pilot-email/quote-save-server-proof.ts',
      'scripts/pilot-email/quote-save-server-cases.ts', 'scripts/pilot-email/quote-save-server-native-cases.ts',
      'src/lib/quotes/pilotQuoteSave.ts', 'src/lib/quotes/pilotQuoteSavePlan.ts', 'src/lib/quotes/pilotQuoteSaveReceipt.ts']) {
      assert.ok(Object.hasOwn(native.sourcePins, file), 'Missing server source pin: ' + file)
    }
    report.sourcePins = native.sourcePins
    report.consumedNativeProofSha256 = sha(bytes)
    report.consumedNativeProof = { passed: native.passed, failed: native.failed, completedAt: native.completedAt }
    const synthetic = await runQuoteSaveServerCases()
    report.synthetic = synthetic
    report.syntheticEvidence = quoteSaveServerEvidence
    assert.ok(synthetic.length > 0 && synthetic.every(test => test.pass), 'Synthetic HTTP/transport boundary failed')
    openAttempted = true
    db = await DisposableSession.open('quote-save-server-proof')
    openCompleted = true
    report.databaseVersion = (await db.query('select version() as version')).rows[0].version
    const integration = await runQuoteSaveServerNativeCases(db)
    report.native = integration
    report.nativeEvidence = quoteSaveServerNativeEvidence
    const all: TestResult[] = [...synthetic, ...integration]
    report.passed = all.filter(test => test.pass).length
    report.failed = all.filter(test => !test.pass).length
    report.pass = integration.length > 0 && all.every(test => test.pass)
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Dormant server proof failed'
  } finally {
    try { await db?.close(); report.allSessionsClosed = !openAttempted || openCompleted }
    catch { report.allSessionsClosed = false; report.pass = false; report.error = 'Server fixture session exit could not be confirmed' }
    if (!report.allSessionsClosed) {
      report.pass = false
      report.closureLimitation = 'Opening or closing the single fixture session failed; exit is not confirmed.'
    }
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'server-save-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
