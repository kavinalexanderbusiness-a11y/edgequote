// ── Day-actions measurement harness (investigation tool, not a guard) ────────
// Renders the Session-80 surfaces to static markup — the REAL CompleteConfirm
// dialog and the REAL JobMessages panel — wrapped in the compiled Tailwind CSS
// so headless Chrome can lay them out and measure (prove-dayactions-mobile.mjs).
// Same credential-free posture as inbox-harness: the signed-in day board cannot
// be driven on this machine, so the component tree is measured directly.
//
// The done-card row's new controls (Request review / the asked-chip / the
// overflow menu) reuse ActionBtn + the chip idiom the shipped board already
// proved at 375/390/430 — their classes are pinned by verify:day-actions; the
// NEW chrome measured here is the completion dialog, which had no precedent.
//
// Usage: npx tsx --tsconfig tsconfig.harness.json scripts/dayactions-harness.tsx <outdir>

// JobMessages constructs a supabase browser client during render (useMemo) —
// give it the same placeholders CI builds with, before the import graph loads.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://placeholder.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-anon-key-for-build-only'

import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, readdirSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { CompleteConfirm } from '../src/components/schedule/CompleteConfirm'
import { JobMessages } from '../src/components/schedule/JobMessages'

const outdir = process.argv[2] || '.dayactions-harness'
mkdirSync(outdir, { recursive: true })

const cssDir = '.next/static/css'
const css = readdirSync(cssDir).filter(f => f.endsWith('.css'))
  .map(f => readFileSync(join(cssDir, f), 'utf8')).join('\n')

const TEXT = `Hi Sarah, we've finished up at 123 Main St SW — thanks for choosing Edge Property Services.

Anything not right? Just reply and we'll sort it out.`

const noop = () => undefined

const scenarios: Record<string, React.ReactElement> = {
  // The completion dialog, both consent postures. Long realistic body — the
  // measurement is whether the footer's two completions stay tappable with the
  // sheet at phone heights, not whether a short string fits.
  'complete-both-channels': (
    <CompleteConfirm open customerName="Sarah Brown" channels={['sms', 'email']} contactKnown
      text={TEXT} onText={noop} busy={false} onConfirm={noop} onCancel={noop} />
  ),
  'complete-unknown-consent': (
    <CompleteConfirm open customerName="Constantinopoulos Property Management Ltd." channels={[]} contactKnown={false}
      text={TEXT} onText={noop} busy={false} onConfirm={noop} onCancel={noop} />
  ),
  // The per-visit message panel in its opening state (the preset grid) — the
  // real component; effects don't run in static markup, so it renders exactly
  // the first paint a phone shows.
  'message-panel': (
    <main className="max-w-md mx-auto p-4">
      <div className="rounded-lg border border-border bg-bg-secondary p-2.5">
        <JobMessages jobId="j1" customerId="c1" customerName="Sarah Brown"
          visitDate="2026-08-16" timeWindow="9–11 AM" address="123 Main St SW" />
      </div>
    </main>
  ),
}

const wrap = (body: string) => `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-bg text-ink">${body}</body></html>`

for (const [name, el] of Object.entries(scenarios)) {
  const html = wrap(renderToStaticMarkup(el))
  writeFileSync(join(outdir, `${name}.html`), html)
  console.log(`${name}.html  ${(html.length / 1024).toFixed(0)} kB`)
}
