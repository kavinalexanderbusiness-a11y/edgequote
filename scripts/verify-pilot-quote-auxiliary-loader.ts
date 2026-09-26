import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build, type Loader, type Plugin } from 'esbuild'
import { runQuoteAuxiliaryLoaderCases, quoteAuxiliaryLoaderEvidence, auxiliaryId } from './pilot-email/quote-auxiliary-loader-cases'
import { quoteAuxiliaryMountedFixture } from './pilot-email/quote-auxiliary-loader-mounted-fixture'
import { projectPilotQuoteSaveBaseline } from '../src/lib/quotes/pilotQuoteSaveBaselineServer'
import { quoteSaveBaselineFixture } from './pilot-email/quote-save-baseline-fixtures'
import { runIsolatedQuoteBrowser } from './pilot-email/quote-save-caller-cases'
import type { TestResult } from './pilot-email/database'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const files = [
  'scripts/verify-pilot-quote-auxiliary-loader.ts',
  'scripts/pilot-email/quote-auxiliary-loader-cases.ts', 'scripts/pilot-email/quote-auxiliary-loader-mounted-fixture.ts',
  'scripts/pilot-email/quote-save-caller-cases.ts', 'scripts/pilot-email/quote-save-baseline-fixtures.ts',
  'src/lib/quotes/pilotQuoteAuxiliaryLoader.ts', 'src/components/quotes/PilotQuoteSaveOwnerEditor.tsx',
  'src/components/quotes/PilotQuoteSaveEditorShell.tsx', 'src/components/quotes/QuoteBuilder.tsx',
  'src/components/layout/CacheOwner.tsx', 'src/lib/clientCache.ts', 'src/hooks/useAutosave.ts',
  'src/lib/autosaveSubmission.ts', 'src/lib/quotes/pilotQuoteSaveCaller.ts',
  'src/lib/quotes/pilotQuoteSaveBaselineServer.ts', 'src/lib/quotes/pilotQuoteSaveBaseline.ts',
  'src/lib/quotes/pilotQuoteSavePlan.ts', 'src/lib/quotes/pilotQuoteIdentity.ts',
  'src/lib/quotes/pilotQuoteSaveValues.ts', 'src/lib/quotes/pilotQuoteSaveReceipt.ts',
  'src/lib/quotes/pilotQuoteSaveEditor.ts', 'src/lib/authState.ts', 'src/types/index.ts',
  'src/hooks/useAiAssist.ts', 'src/lib/units.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
]
const aliases: Record<string, string> = {
  'next/navigation': `export function useRouter(){return window.__auxiliaryIO.router}`,
  'next/link': `import React from 'react';export default function Link({href,children,prefetch,replace,scroll,shallow,locale,...props}){return <a {...props} href={typeof href==='string'?href:'#'} onClick={e=>{e.preventDefault();window.__auxiliaryIO.router.push(String(href))}}>{children}</a>}`,
  '@/lib/supabase/client': `export function createClient(){return window.__auxiliaryIO.client()}`,
}

async function main() {
  const output = resolve('outputs/pilot-full-quote-save-20260910/quote-auxiliary-loader-proof.json')
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), pass: false,
    scope: 'Real Supabase SDK at synthetic HTTP fetch boundary; actual dormant loader/owner hook/Shell/Builder/CacheOwner. Existing baseline projector over synthetic native-shaped snapshot.',
    limits: ['No live Auth/PostgREST or production route activation', 'No native SQL or durable outer COMMIT',
      'Optional AI/provider/scanning descendants are paused in the verified pilot mode', 'Browser DOM events are not trusted OS input',
      'Bundle/vendor hashes identify consumed inputs; no independent rebuild or visual styling certification'],
    productionCalls: 0, externalProviderCalls: 0, injectedReadyContext: false,
    aliases: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, { sha256: sha(value), source: value }])),
    browserHarness: {},
  }
  let before: Record<string, string> = {}
  try {
    const chrome = process.argv[2] ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome')
    if (!existsSync(chrome)) throw Error('Existing isolated Chrome required; no installation or skip fallback')
    before = Object.fromEntries(files.map(file => [file, sha(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))]))
    report.sourcePins = before
    report.checkout = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
      workingFilesMayDifferFromCommit: true }
    report.sdk = await runQuoteAuxiliaryLoaderCases()
    report.sdkEvidence = quoteAuxiliaryLoaderEvidence
    if (!(report.sdk as TestResult[]).every(result => result.pass)) throw Error('Actual SDK unit group failed; browser launch skipped')
    const first = quoteSaveBaselineFixture()
    const second = JSON.parse(JSON.stringify(first).replace(/85000000-0000-4000-8000-(\d{12})/g,
      (_all, n: string) => auxiliaryId(Number(n) + 80)).replaceAll('Synthetic customer', 'Synthetic customer B').replaceAll('10 Synthetic Street', '90 Synthetic Avenue'))
    const baselines = [projectPilotQuoteSaveBaseline(first, { ownerId: auxiliaryId(1), quoteId: auxiliaryId(2) }),
      projectPilotQuoteSaveBaseline(second, { ownerId: auxiliaryId(81), quoteId: auxiliaryId(82) })]
    if (JSON.stringify(baselines).includes('PRIVATE_BASELINE_SENTINEL')) throw Error('Private synthetic snapshot fields escaped actual projector')
    report.baselineProjection = { source: 'projectPilotQuoteSaveBaseline', count: baselines.length, publicBytes: Buffer.byteLength(JSON.stringify(baselines)), sha256: sha(JSON.stringify(baselines)), privateSentinelAbsent: true }
    const fixture = quoteAuxiliaryMountedFixture(baselines), consumed = new Map<string, Buffer>()
    const plugin: Plugin = { name: 'actual-sdk-synthetic-http', setup(context) {
      context.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/supabase\/client)$/ }, args => ({ path: args.path, namespace: 'auxiliary-test-io' }))
      context.onLoad({ filter: /.*/, namespace: 'auxiliary-test-io' }, args => ({ contents: aliases[args.path], loader: 'tsx', resolveDir: process.cwd() }))
      context.onLoad({ filter: /\.(?:[cm]?js|jsx|ts|tsx|json)$/, namespace: 'file' }, args => {
        const bytes = readFileSync(args.path); consumed.set(resolve(args.path), bytes)
        const ext = extname(args.path).slice(1), loader = (ext === 'mjs' || ext === 'cjs' ? 'js' : ext) as Loader
        return { contents: bytes, loader, resolveDir: dirname(args.path) }
      })
    } }
    const bundle = await build({ stdin: { contents: fixture, sourcefile: 'quote-auxiliary-mounted-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx' },
      write: false, bundle: true, metafile: true, platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic',
      tsconfig: resolve('tsconfig.json'), define: { 'process.env.NODE_ENV': '"development"' }, plugins: [plugin], logLevel: 'silent' })
    const pins: Record<string, string> = {}, virtual: Record<string, { bytes: number; kind: string }> = {}
    for (const [path, input] of Object.entries(bundle.metafile.inputs)) {
      if (path === 'quote-auxiliary-mounted-fixture.tsx') pins[path] = sha(fixture)
      else if (path.startsWith('auxiliary-test-io:')) pins[path] = sha(aliases[path.slice('auxiliary-test-io:'.length)])
      else if (/^\(disabled\):(buffer|crypto)$/.test(path) && input.bytes === 0) virtual[path] = { bytes: 0, kind: 'esbuild disabled browser input, not a file hash' }
      else {
        const bytes = consumed.get(resolve(path)); if (!bytes) throw Error('Uncaptured input ' + path)
        pins[relative(process.cwd(), resolve(path)).replaceAll('\\', '/')] = sha(bytes)
      }
    }
    report.bundle = { sourcePins: pins, virtualInputs: virtual, fixtureSha256: sha(fixture), fixtureBytes: Buffer.byteLength(fixture),
      sha256: sha(bundle.outputFiles[0].text), bytes: bundle.outputFiles[0].contents.length }
    report.mounted = await runIsolatedQuoteBrowser(bundle.outputFiles[0].text, report.browserHarness as Record<string, unknown>, chrome)
    const all = [...report.sdk as TestResult[], ...report.mounted as TestResult[]]
    report.passed = all.filter(result => result.pass).length; report.failed = all.filter(result => !result.pass).length
    const after = Object.fromEntries(files.map(file => [file, sha(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))]))
    report.sourceUnchangedDuringRun = JSON.stringify(before) === JSON.stringify(after)
    report.pass = all.length > 0 && (report.mounted as TestResult[]).length > 0 && all.every(result => result.pass) && report.sourceUnchangedDuringRun
  } catch (error) { report.error = error instanceof Error ? error.message.slice(0, 2000) : 'Auxiliary proof failed' }
  finally {
    report.sdkEvidence = quoteAuxiliaryLoaderEvidence
    report.completedAt = new Date().toISOString(); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ output, pass: report.pass, passed: report.passed, failed: report.failed, error: report.error }))
    if (!report.pass) process.exitCode = 1
  }
}
void main()
