// ── Browser entry for the hydrated fixture ───────────────────────────────────
// Bundled by dashboard-hydrated-harness.tsx (esbuild, real react-dom/client).
// hydrateRoot — not createRoot — so the markup the harness server-rendered is
// adopted the way Next adopts its own: a mismatch is a recoverable error that
// React reports here, and the prover reads the list and fails on a non-empty one.
import React from 'react'
import { hydrateRoot } from 'react-dom/client'
import { App } from './dashboard-hydrated-app'

declare global {
  interface Window { __hydrationErrors: string[] }
}

window.__hydrationErrors = []
const root = document.getElementById('root')
if (!root) throw new Error('fixture: #root is missing')
hydrateRoot(root, <App />, {
  onRecoverableError: err => { window.__hydrationErrors.push(String((err as Error)?.message ?? err)) },
})
