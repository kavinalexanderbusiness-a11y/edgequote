import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MARKER = 'EDGEHQ_DISPOSABLE_REAL_AUTH_SAVE_ONLY'
const ORIGIN = 'http://localhost:3000'
const SUPABASE_URL = 'http://127.0.0.1:8000'
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
}

// Resolve existing ancestors too: a not-yet-created directory beneath a symlink
// must not evade the rule that the temporary app is outside the whole checkout.
async function prospectiveRealpath(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await prospectiveRealpath(parent), relative(parent, path))
  }
}

/** Generate only an isolated, disposable Next development mount. The caller
 * owns source/SHA verification, internal-network containment and cleanup.
 * This helper starts nothing, installs nothing and never writes in source. */
export async function generateMount({ source, directory, marker, lostAcknowledgement, versionedAcceptance, lockOrderAcceptance }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || marker !== MARKER) throw Error('Disposable cloud generation required')
  if (typeof source !== 'string' || typeof directory !== 'string' || !isAbsolute(source) || !isAbsolute(directory)) {
    throw Error('Absolute source and temporary directory required')
  }
  const sourceRoot = await realpath(source)
  if (!(await stat(sourceRoot)).isDirectory()) throw Error('Source checkout directory required')
  const target = await prospectiveRealpath(resolve(directory))
  if (inside(sourceRoot, target) || inside(target, sourceRoot)) throw Error('Temporary mount and source checkout must not overlap')
  if (lockOrderAcceptance && (lockOrderAcceptance !== true || lostAcknowledgement || versionedAcceptance)) throw Error('Lock-order mount cannot contain response/authority fault gates')
  if (lostAcknowledgement) {
    const fault = await realpath(lostAcknowledgement.directory)
    if (fault !== lostAcknowledgement.directory || dirname(fault) !== dirname(target) || fault === target
      || inside(sourceRoot, fault) || inside(fault, sourceRoot)
      || !['ownerId', 'quoteId'].every(k => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(lostAcknowledgement[k]))) {
      throw Error('Private sibling fault directory and fixed synthetic identity required')
    }
  }
  if (versionedAcceptance) {
    const gate = await realpath(versionedAcceptance.directory)
    if (lostAcknowledgement || gate !== versionedAcceptance.directory || dirname(gate) !== dirname(target) || gate === target
      || inside(sourceRoot, gate) || inside(gate, sourceRoot)
      || !['ownerId', 'quoteId'].every(k => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(versionedAcceptance[k]))) {
      throw Error('Private sibling acceptance gate and fixed synthetic identity required')
    }
  }
  try { if ((await readdir(target)).length !== 0) throw Error('Temporary mount directory must be empty') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const required = ['src/components/layout/CacheOwner.tsx', 'src/components/quotes/PilotQuoteSaveOwnerEditor.tsx',
    'src/components/ui/Toaster.tsx', 'src/components/ui/ConfirmHost.tsx', 'src/lib/supabase/client.ts',
    'src/lib/supabase/server.ts', 'src/lib/supabase/admin.ts', 'src/lib/quotes/pilotQuoteSaveAuth.ts',
    'src/lib/quotes/pilotQuoteSave.ts', 'src/lib/quotes/pilotQuoteSaveBaselineServer.ts', 'node_modules/next/dist/bin/next']
  for (const path of required) if (!(await stat(join(sourceRoot, path))).isFile()) throw Error('Missing canonical mount dependency: ' + path)
  const packages = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const dependencies = Object.fromEntries(['next', 'react', 'react-dom', '@supabase/ssr', '@supabase/supabase-js'].map(name => {
    const version = packages.dependencies?.[name]
    if (typeof version !== 'string') throw Error('Missing locked source dependency: ' + name)
    return [name, version]
  }))
  const literal = JSON.stringify
  const runtimeChecks = `
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.PILOT_AUTH_SAVE_MARKER !== ${literal(MARKER)}
    || process.env.NODE_ENV !== 'development') throw Error('Disposable development mount only')
  if (process.env.NEXT_PUBLIC_APP_URL !== ${literal(ORIGIN)}
    || process.env.NEXT_PUBLIC_SUPABASE_URL !== ${literal(SUPABASE_URL)}) throw Error('Fixed disposable origins required')
  if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) throw Error('Disposable public key required')
`
  const files = {
    'package.json': JSON.stringify({ name: 'edgequote-disposable-auth-save-mount', version: '0.0.0', private: true, dependencies }, null, 2) + '\n',
    'next.config.mjs': `import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
const require = createRequire(import.meta.url)
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')
const source = ${literal(sourceRoot)}
export default function config(phase) {
  // Reject build/start even if every disposable environment flag is present.
  if (phase !== PHASE_DEVELOPMENT_SERVER) throw Error('Production phases are forbidden for this test mount')
  ${runtimeChecks}
  if (realpathSync(source) !== source) throw Error('Source identity changed')
  return {
    poweredByHeader: false,
    experimental: { externalDir: true },
    webpack(config) {
      config.resolve.alias = { ...config.resolve.alias, '@': ${literal(join(sourceRoot, 'src'))} }
      return config
    },
  }
}
`,
    'tsconfig.json': JSON.stringify({ compilerOptions: {
      target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], strict: true, noEmit: true, skipLibCheck: true,
      esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true,
      isolatedModules: true, jsx: 'preserve', incremental: false, plugins: [{ name: 'next' }],
      baseUrl: target, paths: { '@/*': [join(sourceRoot, 'src', '*')] },
    }, include: ['next-env.d.ts', 'proof-server.ts', 'app/**/*.ts', 'app/**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }, null, 2) + '\n',
    'next-env.d.ts': '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    'proof-server.ts': `import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPilotQuoteSaveAuth } from '@/lib/quotes/pilotQuoteSaveAuth'
import { createPilotQuoteSaveStore } from '@/lib/quotes/pilotQuoteSave'

export const trustedOrigin = ${literal(ORIGIN)}
export function assertProofRuntime() { ${runtimeChecks} }
export async function proofPorts() {
  assertProofRuntime()
  const userClient = await createClient()
  const serviceClient = createAdminClient()
  if (!serviceClient) throw Error('Disposable server credential required')
  return { auth: createPilotQuoteSaveAuth(userClient), store: createPilotQuoteSaveStore(serviceClient) }
}
`,
    'app/layout.tsx': `import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/Toaster'
import { ConfirmHost } from '@/components/ui/ConfirmHost'
import './proof.css'

// Essential hosts only: no production layout, middleware, PWA or monitoring.
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><Toaster /><ConfirmHost />{children}</body></html>
}
`,
    'app/proof.css': `/* Minimal visibility only; this mount makes no visual parity claim. */
html { color-scheme: light; font-family: system-ui, sans-serif; }
body { margin: 0 auto; padding: 24px; max-width: 1100px; color: #171717; background: #fff; }
button, input, textarea, select { font: inherit; }
button, input, textarea, select { padding: 8px; border: 1px solid #777; border-radius: 4px; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .55; }
label { display: block; margin-top: 8px; } textarea { min-height: 70px; }
input, textarea, select { max-width: 100%; } section { margin: 16px 0; }
[hidden], .hidden { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
.pointer-events-none { pointer-events: none; }
:focus-visible { outline: 2px solid #2054aa; outline-offset: 2px; }
`,
    'app/login/page.tsx': `import { assertProofRuntime } from '../../proof-server'
import Login from './Login'
export const dynamic = 'force-dynamic'
export default async function Page({ searchParams }: { searchParams: Promise<{ quoteId?: string }> }) {
  assertProofRuntime()
  const { quoteId } = await searchParams
  if (!quoteId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(quoteId)) return <p>A valid synthetic quote ID is required.</p>
  return <Login quoteId={quoteId} />
}
`,
    'app/login/Login.tsx': `'use client'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function Login({ quoteId }: { quoteId: string }) {
  const client = useMemo(() => createClient(), [])
  const [email, setEmail] = useState(''), [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => { setReady(true) }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || busy) return; setBusy(true); setError(false)
    try {
      const result = await client.auth.signInWithPassword({ email, password })
      if (result.error || !result.data.user) { setError(true); return }
      // Hard navigation lets the canonical server client verify actual cookies.
      window.location.assign('/quote?quoteId=' + encodeURIComponent(quoteId))
    } catch { setError(true) }
    finally { setBusy(false) }
  }
  return <main><h1>Disposable authenticated Save proof</h1><form onSubmit={submit}>
    <label htmlFor="proof-email">Email</label><input id="proof-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required />
    <label htmlFor="proof-password">Password</label><input id="proof-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
    <output data-testid="login-ready" hidden>{ready ? 'ready' : 'pending'}</output>
    <button type="submit" disabled={!ready || busy}>Sign in</button>
    {error && <p role="alert">Sign in could not be verified.</p>}
  </form></main>
}
`,
    'app/quote/page.tsx': `import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { CacheOwner } from '@/components/layout/CacheOwner'
import { assertProofRuntime } from '../../proof-server'
import Editor from './Editor'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export default async function Page({ searchParams }: { searchParams: Promise<{ quoteId?: string }> }) {
  assertProofRuntime()
  const { quoteId } = await searchParams
  if (!quoteId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(quoteId)) return <p>A valid synthetic quote ID is required.</p>
  const client = await createClient()
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return <main><p>Sign in to verify your quote data.</p><Link href={'/login?quoteId=' + encodeURIComponent(quoteId)}>Sign in</Link></main>
  // CacheOwner must render before any descendant can adopt a cache lease.
  return <main><CacheOwner id={data.user.id} /><Editor quoteId={quoteId} /></main>
}
`,
    'app/quote/Editor.tsx': `'use client'
import { useState } from 'react'
import { PilotQuoteSaveOwnerEditor } from '@/components/quotes/PilotQuoteSaveOwnerEditor'
import type { PilotQuoteSaveIntent } from '@/lib/quotes/pilotQuoteSaveValues'

async function post(path: '/api/baseline' | '/api/save', body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  // Preserve actual refusal bodies as well as receipts. No retries, fake success
  // responses, token extraction, draft replacement or reconciliation inference.
  return response.json()
}
export default function Editor({ quoteId }: { quoteId: string }) {
  const [closed, setClosed] = useState(0), [reconciliations, setReconciliations] = useState(0)
  return <><aside aria-label="Proof observations">
    <span data-testid="closed-count">{closed}</span><span data-testid="reconciliation-count">{reconciliations}</span>
  </aside><PilotQuoteSaveOwnerEditor quoteId={quoteId}
    loadBaseline={(id, signal) => post('/api/baseline', { version: 1, quoteId: id }, signal)}
    write={(intent: PilotQuoteSaveIntent) => post('/api/save', intent)}
    readReconciliation={async () => { setReconciliations(n => n + 1); throw Error('Reconciliation is outside this acknowledged Save proof') }}
    onClose={() => setClosed(n => n + 1)} /></>
}
`,
    'app/api/baseline/route.ts': `import { loadPilotQuoteSaveBaselineRequest } from '@/lib/quotes/pilotQuoteSaveBaselineServer'
import { proofPorts, trustedOrigin } from '../../../proof-server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const { auth, store } = await proofPorts()
  return loadPilotQuoteSaveBaselineRequest(store, auth, request, { trustedOrigin })
}
`,
    'app/api/save/route.ts': `import { savePilotQuoteSaveRequest } from '@/lib/quotes/pilotQuoteSave'
import { proofPorts, trustedOrigin } from '../../../proof-server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const { auth, store } = await proofPorts()
  return savePilotQuoteSaveRequest(store, auth, request, { trustedOrigin })
}
`,
  }
  if (lostAcknowledgement) {
    files['proof-fault.ts'] = `import 'server-only'
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { assertProofRuntime } from './proof-server'
import { parsePilotQuoteSaveReceipt } from '@/lib/quotes/pilotQuoteSaveReceipt'
import type { PilotQuoteSaveStore } from '@/lib/quotes/pilotQuoteSave'
import type { PilotQuoteSaveIntent } from '@/lib/quotes/pilotQuoteSaveValues'

// Test-only response delivery seam. This file is generated outside the checkout,
// never imported by a production route and never gives the browser a receipt.
const directory = ${literal(lostAcknowledgement.directory)}
const ownerId = ${literal(lostAcknowledgement.ownerId)}, quoteId = ${literal(lostAcknowledgement.quoteId)}
export async function event(kind: string, operationId?: string) {
  assertProofRuntime()
  await appendFile(join(directory, 'events.jsonl'), JSON.stringify({ kind, at: new Date().toISOString(), operationId }) + '\\n', { mode: 0o600 })
}
export function observedStore(store: PilotQuoteSaveStore): PilotQuoteSaveStore {
  return { ...store, commit: async (owner, quote, plan, signal) => {
    await event('native-commit-dispatch', plan.client_operation_id)
    const result = await store.commit(owner, quote, plan, signal)
    await event('native-commit-return', plan.client_operation_id)
    return result
  } }
}
export async function deliver(response: Response, intent: PilotQuoteSaveIntent) {
  if (response.status !== 200 || intent?.quoteId !== quoteId) return response
  const raw = await response.clone().text()
  const pending = { version: 1 as const, owner: ownerId, quoteId, clientOperationId: intent.clientOperationId,
    editorGeneration: intent.editorGeneration, originalEditorRevision: intent.expectedEditorRevision,
    submittedValues: intent.values, submittedSerialization: JSON.stringify(intent.values), stagedAt: Date.now(), state: 'pending' as const }
  const receipt = parsePilotQuoteSaveReceipt(JSON.parse(raw), pending)
  if (!receipt) throw Error('Fault refused a non-attributable canonical response')
  try { await writeFile(join(directory, 'claimed'), intent.clientOperationId, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return response; throw error }
  await event('committed-response-held', intent.clientOperationId)
  await writeFile(join(directory, 'committed.tmp'), JSON.stringify({ intent, receipt }), { flag: 'wx', mode: 0o600 })
  await rename(join(directory, 'committed.tmp'), join(directory, 'committed.json'))
  async function waitForBarrier() {
   const deadline = Date.now() + 90000
   while (true) {
    let barrier: { operationId?: string; observedDigest?: string } | null = null
    try { barrier = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (barrier) {
      if (barrier.operationId !== intent.clientOperationId || !/^[0-9a-f]{64}$/.test(barrier.observedDigest ?? '')) throw Error('Wrong SQL observation barrier')
      return
    }
    if (Date.now() >= deadline) throw Error('SQL commit observation barrier timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
   }
  }
  const authenticBytes = new TextEncoder().encode(raw)
  let prefixSent = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) { prefixSent = true; controller.enqueue(authenticBytes.slice(0, 1)); return }
      await waitForBarrier()
      await event('response-dropped', intent.clientOperationId)
      controller.error(new Error('Disposable intentional lost Save response'))
    },
  })
  // The only altered boundary is delivery: original status/headers and an
  // authentic prefix, followed by a real stream failure, never a replacement JSON.
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
`
    files['app/api/save/route.ts'] = `import { savePilotQuoteSaveRequest } from '@/lib/quotes/pilotQuoteSave'
import { proofPorts, trustedOrigin } from '../../../proof-server'
import { deliver, event, observedStore } from '../../../proof-fault'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const retained = request.clone()
  await event('save-request')
  const { auth, store } = await proofPorts()
  const response = await savePilotQuoteSaveRequest(observedStore(store), auth, request, { trustedOrigin })
  if (response.status !== 200) { void retained.body?.cancel().catch(() => {}); return response }
  const intent = await retained.json()
  return deliver(response, intent)
}
`
  }
  if (versionedAcceptance || lockOrderAcceptance) {
    files['proof-acceptance.ts'] = lockOrderAcceptance ? `import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPilotQuoteSaveAuth } from '@/lib/quotes/pilotQuoteSaveAuth'
import { createPilotQuoteAcceptanceStore } from '@/lib/quotes/pilotQuoteAcceptanceServer'
import { assertProofRuntime } from './proof-server'
export async function acceptancePorts() {
  assertProofRuntime()
  const client = await createClient()
  const service = createAdminClient()
  if (!service) throw Error('Disposable service client unavailable')
  return { auth: createPilotQuoteSaveAuth(client), store: createPilotQuoteAcceptanceStore(service) }
}
` : `import 'server-only'
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPilotQuoteSaveAuth } from '@/lib/quotes/pilotQuoteSaveAuth'
import { createPilotQuoteAcceptanceStore } from '@/lib/quotes/pilotQuoteAcceptanceServer'
import { assertProofRuntime } from './proof-server'

const directory = ${literal(versionedAcceptance.directory)}
const ownerId = ${literal(versionedAcceptance.ownerId)}, quoteId = ${literal(versionedAcceptance.quoteId)}
async function event(kind: string, quote: string, owner: string | null, operationId?: string) {
  assertProofRuntime()
  await appendFile(join(directory, 'events.jsonl'), JSON.stringify({ kind, quoteId: quote, ownerId: owner, operationId,
    at: new Date().toISOString() }) + '\\n', { mode: 0o600 })
}
export async function acceptancePorts() {
  assertProofRuntime()
  const client = await createClient(), service = createAdminClient()
  if (!service) throw Error('Disposable server credential required')
  const actual = createPilotQuoteAcceptanceStore(service)
  const store: typeof actual = {
    preview: async (a, r, signal) => { await event('acceptance-preview-dispatch', r.quoteId, a.owner); return actual.preview(a, r, signal) },
    reconcile: async (a, r, signal) => { await event('acceptance-reconcile-dispatch', r.quoteId, a.owner, r.clientOperationId); return actual.reconcile(a, r, signal) },
    commit: async (a, r, signal) => {
      if (a.owner === ownerId && r.quoteId === quoteId) {
        let claimed = false
        try { await writeFile(join(directory, 'claimed'), r.clientOperationId, { flag: 'wx', mode: 0o600 }); claimed = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        if (claimed) {
          // Reached only after the actual adapter verified owner Auth/role.
          await event('owner-authority-passed-before-native', r.quoteId, a.owner, r.clientOperationId)
          await writeFile(join(directory, 'held.tmp'), JSON.stringify({ operationId: r.clientOperationId, ownerId, quoteId }), { flag: 'wx', mode: 0o600 })
          await rename(join(directory, 'held.tmp'), join(directory, 'held.json'))
          const deadline = Date.now() + 10000
          while (true) {
            let release: { operationId?: string } | null = null
            try { release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            if (release) { if (release.operationId !== r.clientOperationId) throw Error('Mismatched authority barrier'); break }
            if (signal.aborted || Date.now() >= deadline) throw Error('Bounded acceptance authority barrier expired')
            await new Promise(resolve => setTimeout(resolve, 20))
          }
        }
      }
      await event('acceptance-commit-dispatch', r.quoteId, a.owner, r.clientOperationId)
      const result = await actual.commit(a, r, signal)
      await event('acceptance-commit-return', r.quoteId, a.owner, r.clientOperationId)
      return result
    },
  }
  return { auth: createPilotQuoteSaveAuth(client), store }
}
`
    for (const [mode, handler] of [['preview', 'previewQuoteAcceptance'], ['commit', 'commitQuoteAcceptance'], ['reconcile', 'reconcileQuoteAcceptance']]) {
      files['app/api/acceptance/' + mode + '/route.ts'] = `import { ${handler} } from '@/lib/quotes/pilotQuoteAcceptanceServer'
import { acceptancePorts } from '../../../../proof-acceptance'
import { trustedOrigin } from '../../../../proof-server'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  const { auth, store } = await acceptancePorts()
  return ${handler}(store, auth, request, { trustedOrigin })
}
`
    }
  }
  await mkdir(target, { recursive: true })
  if (await realpath(target) !== target || inside(sourceRoot, target) || inside(target, sourceRoot)) throw Error('Temporary mount location changed')
  // One physical dependency tree avoids separate React or client-cache module
  // identities. No install, production bundle, credentials file or source copy.
  await symlink(join(sourceRoot, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(target, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents, { flag: 'wx' })
  }
  return { directory: target, source: sourceRoot, nextBin: join(sourceRoot, 'node_modules/next/dist/bin/next'),
    origin: ORIGIN, supabaseUrl: SUPABASE_URL, files: Object.keys(files) }
}
