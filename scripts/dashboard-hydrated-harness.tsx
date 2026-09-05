// ── Hydrated Customize-sheet fixture: server render + browser bundle ─────────
// The static dashboard-a11y fixture proved geometry, names and native tab
// order, and said plainly what static markup cannot prove: the Modal's focus
// trap, Escape, focus restore, the switches' and arrows' state changes. This
// harness closes that gap without a dev server: it renders the same real
// components with renderToString, bundles the same components for the browser
// with esbuild (the one tsx already ships), and emits a page whose script
// hydrateRoot-adopts the server markup. scripts/prove-dashboard-hydrated.mjs
// then drives the real handlers in headless Chrome.
//
// What is real: React 18 runtime, CustomizeDashboard, Modal, Toggle, Button,
// Toaster, lib/dashboard/layout, lib/toast, the Supabase browser client. What
// is stubbed: next/navigation (useRouter) and next/link — the two harness stubs
// every static harness in scripts/ already uses. What is synthetic: the props,
// and the NEXT_PUBLIC_* env baked into the bundle — a CLOSED loopback port,
// never a project; the values are fixed here and deliberately NOT read from the
// environment, so no shell can leak a real key into the page.
//
// Usage (needs compiled Tailwind from any .next build; no server, no browser):
//   CSS_DIR=<...>/.next/static/css npx tsx --tsconfig tsconfig.harness.json \
//     scripts/dashboard-hydrated-harness.tsx [outdir=.dashboard-hydrated]
import { renderToString } from 'react-dom/server'
import { build } from 'esbuild'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import React from 'react'
import { App } from './dashboard-hydrated-app'

const outdir = process.argv[2] || '.dashboard-hydrated'
mkdirSync(outdir, { recursive: true })
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

const cssDir = process.env.CSS_DIR || '.next/static/css'
const cssFiles = readdirSync(cssDir).filter(f => f.endsWith('.css'))
const css = cssFiles.map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')
if (!/\.tap-target/.test(css) || !/\.animate-panel/.test(css)) {
  throw new Error(`fixture: ${cssDir} does not look like this app's compiled Tailwind (tap-target / animate-panel missing)`)
}

// Synthetic browser env. 127.0.0.1:9 is the discard port — closed on this
// machine, loopback by definition. The prover independently counts every
// request the page makes and fails on any that is not file://.
const ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-anon-key.not-a-credential.synthetic',
  NEXT_PUBLIC_APP_URL: '',
  NODE_ENV: 'development', // React's development build: hydration mismatches are reported, not swallowed
}

async function main() {
  const stubs: Record<string, string> = {
    'next/navigation': resolve('scripts/qb-next-stub.ts'),
    'next/link': resolve('scripts/harness-link-stub.tsx'),
  }
  const result = await build({
    entryPoints: [resolve('scripts/dashboard-hydrated-entry.tsx')],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    jsx: 'automatic', tsconfig: resolve('tsconfig.json'),
    define: Object.fromEntries(Object.entries(ENV).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])),
    // Anything else that still reads process.env at runtime gets an empty env
    // instead of a ReferenceError — and is listed below so it is never a surprise.
    banner: { js: 'var process = typeof process === "undefined" ? { env: {} } : process;' },
    plugins: [{
      name: 'harness-next-stubs',
      setup(b) { b.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: stubs[args.path] })) },
    }],
    logLevel: 'warning',
  })
  let js = result.outputFiles[0].text
  // The supabase-js dist files carry JSDoc examples naming placeholder hosts
  // (xyzcompany, example, project-id, realtime) — measured 36 of them, all in
  // node_modules. Any OTHER *.supabase.co host in the bundle is a real project
  // reference and the page is not written.
  const PLACEHOLDER_HOSTS = new Set(['xyzcompany', 'example', 'project-id', 'realtime'])
  const supabaseHosts = [...new Set([...js.matchAll(/https:\/\/([a-z0-9-]+)\.supabase\.co/gi)].map(m => m[1].toLowerCase()))]
  const projectRefs = supabaseHosts.filter(h => !PLACEHOLDER_HOSTS.has(h))
  if (projectRefs.length) throw new Error(`fixture: the bundle names a Supabase project host (${projectRefs.join(', ')}) — refusing to write it`)
  const leftoverEnv = [...new Set([...js.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]))]
  // The script is external (bundle.js) so its hash stands on its own; the
  // </script> guard is for the day someone inlines it.
  js = js.replace(/<\/script/gi, '<\\/script')

  const markup = renderToString(<App />)
  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Customize sheet — hydrated fixture</title>
<style>${css}</style><style>body{margin:0}</style>
</head><body class="bg-bg text-ink"><div id="root">${markup}</div>
<script src="./bundle.js"></script></body></html>`

  writeFileSync(join(outdir, 'bundle.js'), js)
  writeFileSync(join(outdir, 'index.html'), html)

  // Provenance the prover's log can be matched against: the git blob of every
  // product file the page hydrates, the CSS inputs, and the two outputs.
  const productFiles = [
    'src/components/dashboard/CustomizeDashboard.tsx', 'src/components/ui/Modal.tsx', 'src/components/ui/Toggle.tsx',
    'src/components/ui/Button.tsx', 'src/components/ui/Toaster.tsx', 'src/components/layout/PageHeader.tsx',
    'src/lib/dashboard/layout.ts', 'src/lib/toast.ts', 'src/hooks/useFocusTrap.ts', 'src/lib/supabase/client.ts',
  ]
  let blobs: Record<string, string> = {}
  try {
    const out = execFileSync('git', ['ls-tree', 'HEAD', '--', ...productFiles], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/).filter(Boolean)) { const [meta, path] = line.split('\t'); blobs[path] = meta.split(' ')[2] }
  } catch { blobs = { unavailable: 'git ls-tree failed' } }
  const manifest = {
    generatedAt: new Date().toISOString(),
    head: (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return 'unknown' } })(),
    productBlobs: blobs,
    css: cssFiles.map(f => ({ file: f, sha256: sha(readFileSync(join(cssDir, f))) })),
    bundle: { bytes: js.length, sha256: sha(js) },
    html: { bytes: html.length, sha256: sha(html) },
    env: ENV,
    stubs: Object.keys(stubs),
    leftoverProcessEnvReads: leftoverEnv,
    supabaseHostsInBundle: supabaseHosts, // must all be library placeholders — see PLACEHOLDER_HOSTS
    react: JSON.parse(readFileSync(resolve('node_modules/react/package.json'), 'utf8')).version as string,
    esbuild: JSON.parse(readFileSync(resolve('node_modules/esbuild/package.json'), 'utf8')).version as string,
  }
  writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`index.html  ${(html.length / 1024).toFixed(0)} kB  sha256 ${manifest.html.sha256.slice(0, 16)}`)
  console.log(`bundle.js   ${(js.length / 1024).toFixed(0)} kB  sha256 ${manifest.bundle.sha256.slice(0, 16)}`)
  console.log(`css         ${cssFiles.join(', ')}`)
  console.log(`env baked   ${Object.entries(ENV).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')}`)
  console.log(`process.env still read at runtime: ${leftoverEnv.length ? leftoverEnv.join(', ') : 'none'}`)
}

main().catch(e => { console.error(e); process.exit(1) })
