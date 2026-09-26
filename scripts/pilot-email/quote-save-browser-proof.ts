import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { verifyAutosaveOwnership, verifyBoundAutosaveSafety } from '../lib/autosaveOwnership'
import { runQuoteSaveCallerCases, quoteSaveBrowserHarnessEvidence } from './quote-save-caller-cases'
import { runQuoteSaveMountedCases, quoteSaveMountedHarnessEvidence } from './quote-save-mounted-cases'
import type { TestResult } from './database'

const output = resolve('outputs/pilot-full-quote-save-20260910')
const files = [
  'scripts/pilot-email/quote-save-browser-proof.ts', 'scripts/pilot-email/quote-save-caller-cases.ts',
  'scripts/pilot-email/quote-save-mounted-cases.ts', 'scripts/pilot-email/quote-save-mounted-shell-fixture.ts',
  'scripts/lib/autosaveOwnership.ts', 'src/components/quotes/QuoteBuilder.tsx',
  'src/hooks/useAutosave.ts', 'src/hooks/useAutosaveOwner.ts', 'src/lib/clientCache.ts',
  'src/lib/quotes/pilotQuoteSaveCaller.ts', 'src/lib/quotes/pilotQuoteSaveReceipt.ts',
  'src/components/quotes/PilotQuoteSaveEditorShell.tsx', 'src/components/layout/CacheOwner.tsx',
  'src/lib/quotes/pilotQuoteSaveBaseline.ts', 'src/lib/quotes/pilotQuoteSaveValues.ts', 'src/lib/autosaveSubmission.ts',
  'src/types/index.ts', 'package.json', 'package-lock.json', '.github/workflows/pilot-email-schema.yml',
]

async function main() {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), pass: false,
    scope: 'Separate default ownership guards, source-bound submit seams, and actual dormant editor shell/full QuoteBuilder/CacheOwner in isolated Chrome. Synthetic context, auth identity and transport; not production app/Auth/PostgREST/SQL E2E.',
    mountedRoute: false, externalProviderCalls: 0, productionCalls: 0,
    sourcePins: Object.fromEntries(files.map(file => [file, createHash('sha256')
      .update(readFileSync(resolve(file), 'utf8').replace(/\r\n/g, '\n')).digest('hex')])),
  }
  try {
    const chrome = process.argv[2]
    if (!chrome || !existsSync(chrome)) throw new Error('An existing isolated Chrome executable is required; no install or skip fallback')
    const defaults: TestResult[] = []
    verifyAutosaveOwnership((name, pass, error) => defaults.push({ name, pass, ...(error ? { error } : {}) }))
    report.defaultAutosave = defaults
    const bound: TestResult[] = []
    verifyBoundAutosaveSafety((name, pass, error) => bound.push({ name, pass, ...(error ? { error } : {}) }))
    report.boundAutosave = bound
    report.boundAutosaveScope = 'Source-driven actual hook/helper in deterministic lifecycle host; not React/browser execution.'
    report.browser = await runQuoteSaveCallerCases(chrome)
    report.mountedBrowser = await runQuoteSaveMountedCases(chrome)
    const all = [...defaults, ...bound, ...(report.browser as TestResult[]), ...(report.mountedBrowser as TestResult[])]
    report.passed = all.filter(test => test.pass).length
    report.failed = all.filter(test => !test.pass).length
    report.pass = defaults.length > 0 && bound.length > 0 && (report.browser as TestResult[]).length > 0
      && (report.mountedBrowser as TestResult[]).length > 0 && all.every(test => test.pass)
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Isolated browser proof failed'
  } finally {
    report.browserHarness = quoteSaveBrowserHarnessEvidence
    // Includes exact bytes consumed by esbuild for every transitive source and
    // package input, the generated fixture, replacements and final bundle hash.
    // Collected in finally even if the mounted browser fails during startup.
    report.mountedBrowserHarness = quoteSaveMountedHarnessEvidence
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'browser-save-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
