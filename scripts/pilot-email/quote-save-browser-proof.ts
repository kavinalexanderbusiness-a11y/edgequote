import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { verifyAutosaveOwnership } from '../lib/autosaveOwnership'
import { runQuoteSaveCallerCases } from './quote-save-caller-cases'
import type { TestResult } from './database'

const output = resolve('outputs/pilot-full-quote-save-20260910')
const files = [
  'scripts/pilot-email/quote-save-browser-proof.ts', 'scripts/pilot-email/quote-save-caller-cases.ts',
  'scripts/lib/autosaveOwnership.ts', 'src/components/quotes/QuoteBuilder.tsx',
  'src/hooks/useAutosave.ts', 'src/hooks/useAutosaveOwner.ts', 'src/lib/clientCache.ts',
  'src/lib/quotes/pilotQuoteSaveCaller.ts', 'src/lib/quotes/pilotQuoteSaveReceipt.ts',
  'src/types/index.ts', 'package.json', 'package-lock.json', '.github/workflows/pilot-email-schema.yml',
]

async function main() {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), pass: false,
    scope: 'Actual source-bound QuoteBuilder submit/autosave/lifetime/Cancel seams in React and RHF with isolated Chrome; not full mounted app E2E.',
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
    report.browser = await runQuoteSaveCallerCases(chrome)
    const all = [...defaults, ...(report.browser as TestResult[])]
    report.passed = all.filter(test => test.pass).length
    report.failed = all.filter(test => !test.pass).length
    report.pass = defaults.length > 0 && (report.browser as TestResult[]).length > 0 && all.every(test => test.pass)
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Isolated browser proof failed'
  } finally {
    report.completedAt = new Date().toISOString()
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'browser-save-proof.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
