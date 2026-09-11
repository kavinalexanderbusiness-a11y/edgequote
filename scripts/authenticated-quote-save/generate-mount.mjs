import { mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MARKER = 'EDGEHQ_DISPOSABLE_REAL_AUTH_SAVE_ONLY'
const ORIGIN = 'http://127.0.0.1:3000'
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
export async function generateMount({ source, directory, marker }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || marker !== MARKER) throw Error('Disposable cloud generation required')
  if (typeof source !== 'string' || typeof directory !== 'string' || !isAbsolute(source) || !isAbsolute(directory)) {
    throw Error('Absolute source and temporary directory required')
  }
  const sourceRoot = await realpath(source)
  if (!(await stat(sourceRoot)).isDirectory()) throw Error('Source checkout directory required')
  const target = await prospectiveRealpath(resolve(directory))
  if (inside(sourceRoot, target) || inside(target, sourceRoot)) throw Error('Temporary mount and source checkout must not overlap')
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
