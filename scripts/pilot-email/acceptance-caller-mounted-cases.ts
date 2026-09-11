import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, extname, relative, resolve } from 'node:path'
import { build, type Loader, type Plugin } from 'esbuild'
import type { TestResult } from './database'
import { runIsolatedQuoteBrowser } from './quote-save-caller-cases'
import { acceptanceCallerMountedFixture } from './acceptance-caller-mounted-fixture'
import { portalRefreshMountedFixture } from '../authenticated-quote-save/portal-refresh-mounted-fixture'

// Dormant synthetic full-component proof. The driver supplies response-only
// fixtures emitted by the actual native HTTP adapter proof. This module cannot
// choose/open a database, authenticate, or invoke an external provider.
export type AcceptanceMountedProvenance =
  | { kind: 'native-http-capture'; nativeProofSha256: string; serverProofSha256: string }
  | { kind: 'synthetic-local'; fixtureSourcePins: Record<string, string> }

export const acceptanceCallerMountedHarnessEvidence: Record<string, unknown> = {}

const aliases: Record<string, string> = {
  'next/navigation': `export function useRouter(){return window.__acceptanceTestIO.router}`,
  'next/link': `import React from 'react'; export default function Link({href,children,prefetch,replace,scroll,shallow,locale,...props}){
    return <a {...props} href={typeof href==='string'?href:'#'} onClick={e=>{e.preventDefault();window.__acceptanceTestIO.navigation.push(String(href))}}>{children}</a>}`,
  '@/lib/supabase/client': `export function createClient(){return window.__acceptanceTestIO.client()}`,
}

export async function runAcceptanceCallerMountedCases(
  responseFixtures: unknown[], provenance: AcceptanceMountedProvenance, chrome?: string, selection: 'full' | 'portal-refresh' = 'full',
): Promise<TestResult[]> {
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
  if (selection !== 'full' && selection !== 'portal-refresh') throw new Error('Explicit mounted proof selection required')
  if (selection === 'portal-refresh' && provenance.kind !== 'synthetic-local') throw new Error('Focused refresh proof requires synthetic provenance')
  if (!Array.isArray(responseFixtures) || !responseFixtures.length) throw new Error('Native response-only fixtures are required')
  if (provenance.kind === 'native-http-capture') {
    for (const hash of [provenance.nativeProofSha256, provenance.serverProofSha256]) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Source-bound native/server fixture provenance is required')
    }
  } else {
    if (provenance.kind !== 'synthetic-local' || !Object.keys(provenance.fixtureSourcePins).length) throw new Error('Explicit synthetic fixture provenance is required')
    for (const [path, hash] of Object.entries(provenance.fixtureSourcePins)) {
      if (sha(readFileSync(path)) !== hash) throw new Error('Synthetic fixture source changed: ' + path)
    }
  }
  const fixture = selection === 'portal-refresh' ? portalRefreshMountedFixture(responseFixtures) : acceptanceCallerMountedFixture(responseFixtures, provenance.kind)
  const loadedBytes = new Map<string, Buffer>()
  const plugin: Plugin = {
    name: 'strict-synthetic-acceptance-io',
    setup(context) {
      context.onResolve({ filter: /^(next\/navigation|next\/link|@\/lib\/supabase\/client)$/ }, args => ({ path: args.path, namespace: 'acceptance-test-io' }))
      context.onLoad({ filter: /.*/, namespace: 'acceptance-test-io' }, args => ({ contents: aliases[args.path], loader: 'tsx', resolveDir: process.cwd() }))
      context.onLoad({ filter: /\.(?:[cm]?js|jsx|ts|tsx|json)$/, namespace: 'file' }, args => {
        const contents = readFileSync(args.path)
        loadedBytes.set(resolve(args.path), contents)
        const extension = extname(args.path).slice(1)
        const loader = (extension === 'mjs' || extension === 'cjs' ? 'js' : extension) as Loader
        return { contents, loader, resolveDir: dirname(args.path) }
      })
    },
  }
  const bundle = await build({
    stdin: { contents: fixture, sourcefile: 'acceptance-caller-mounted-fixture.tsx', resolveDir: process.cwd(), loader: 'tsx' },
    write: false, bundle: true, metafile: true, platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic',
    tsconfig: resolve('tsconfig.json'), define: { 'process.env.NODE_ENV': '"development"' }, plugins: [plugin], logLevel: 'silent',
  })
  const pins: Record<string, string> = {}
  const bundlerGeneratedInputs: { path: string; inputBytes: number; kind: string }[] = []
  const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
  for (const path of Object.keys(bundle.metafile.inputs).sort()) {
    if (path === 'acceptance-caller-mounted-fixture.tsx') pins[path] = sha(fixture)
    else if (path.startsWith('acceptance-test-io:')) pins[path] = sha(aliases[path.slice('acceptance-test-io:'.length)])
    else if (path.startsWith('(disabled):') && builtins.has(path.slice('(disabled):'.length))) {
      // The actual portal imports its PDF path; esbuild's browser resolution
      // disables this Node builtin. It has no file/source bytes to hash. Keep
      // the virtual input explicit, rather than claim a inspected vendor file.
      const input = bundle.metafile.inputs[path]
      if (input.bytes !== 0 || input.imports.length !== 0) throw new Error('Unexpected disabled builtin input: ' + path)
      bundlerGeneratedInputs.push({ path, inputBytes: input.bytes, kind: 'esbuild browser-disabled Node builtin; not a source file' })
    }
    else {
      const bytes = loadedBytes.get(resolve(path))
      if (!bytes) throw new Error('Uncaptured acceptance browser dependency: ' + path)
      pins[relative(process.cwd(), resolve(path)).replaceAll('\\', '/')] = sha(bytes)
    }
  }
  for (const path of ['scripts/pilot-email/acceptance-caller-mounted-cases.ts', 'scripts/pilot-email/acceptance-caller-mounted-fixture.ts',
    'scripts/pilot-email/quote-save-caller-cases.ts', 'supabase/proposals/pilot-quote-acceptance-callers-contract.md',
    'tsconfig.json', 'package.json', 'package-lock.json']) pins[path] = sha(readFileSync(path))
  for (const key of Object.keys(acceptanceCallerMountedHarnessEvidence)) delete acceptanceCallerMountedHarnessEvidence[key]
  if (selection === 'portal-refresh') {
    const file = 'scripts/authenticated-quote-save/portal-refresh-mounted-fixture.ts'
    pins[file] = sha(readFileSync(file))
  }
  Object.assign(acceptanceCallerMountedHarnessEvidence, {
    sourcePins: pins, bundleSha256: sha(bundle.outputFiles[0].text), bundleBytes: bundle.outputFiles[0].contents.length,
    replacements: Object.keys(aliases), bundlerGeneratedInputs, fixtureProvenance: provenance,
    responseFixturesSha256: sha(JSON.stringify(responseFixtures)),
    scope: selection === 'portal-refresh' ? 'Five focused actual PortalClient refresh regressions; synthetic acceptance and auxiliary I/O only.'
      : 'Actual PortalClient, RecordAcceptanceDialog and dormant Save editor with synthetic transports; response basis: ' + provenance.kind,
    excluded: ['production routes', 'live Auth/PostgREST', 'browser-to-database transport', 'durable outer-COMMIT attribution', 'providers', 'visual app layout'],
    browser: {},
  })
  return runIsolatedQuoteBrowser(bundle.outputFiles[0].text, acceptanceCallerMountedHarnessEvidence.browser as Record<string, unknown>, chrome)
}
