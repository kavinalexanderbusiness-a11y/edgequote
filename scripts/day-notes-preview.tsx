// Credential-free presentation preview of the real day board and field bar.
// Run from the repository: tsx --tsconfig tsconfig.harness.json scripts/day-notes-preview.tsx <output-dir>
// The day board is server-rendered (its data effects do not run). Only the
// field bar hydrates, using fictional data and inert action callbacks.
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { DayOpsPanel } from '../src/components/schedule/DayOpsPanel'
import { completedJob, fixtureJob, typicalJob } from './day-notes-fixture'

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'placeholder-anon-key-for-preview-only'
  const out = resolve(process.argv[2] || '../evidence/day-notes-preview')
  mkdirSync(out, { recursive: true })
  const noop = () => undefined
  const asyncNoop = async () => undefined
  const renderBoard = (job = fixtureJob) => renderToStaticMarkup(
    <DayOpsPanel date="2026-10-21" dateLabel="Wednesday, October 21" jobs={[job, completedJob]}
      quotesById={{}} recurrences={{}} baseCoord={null} workStartTime="08:00" capacityHours={8}
      onOpenJob={noop} onStartJob={noop} onMarkDone={noop} onMove={noop} onStopForToday={asyncNoop}
      onResume={noop} onDeleteJob={noop} onSetPrice={asyncNoop} onRainDelay={noop} onAddJob={noop}
      onQuickSave={asyncNoop} addonsByJobId={{}} onAddLineItem={asyncNoop} onDeleteLineItem={asyncNoop}
      getPreviousAddons={() => []} onCopyPreviousAddons={asyncNoop} addonTemplates={[]}
      changeOrdersByJobId={{}} onCreateChangeOrder={asyncNoop} onSendChangeOrder={asyncNoop}
      onCancelChangeOrder={asyncNoop} onOwnerChangeDecision={asyncNoop} onRemindChangeOrder={asyncNoop} />,
  )
  execFileSync(process.execPath, ['node_modules/tailwindcss/lib/cli.js', '-i', 'src/app/globals.css', '-o', join(out, 'preview.css')], { stdio: 'inherit' })
  await build({ entryPoints: ['scripts/day-notes-client.tsx'], outfile: join(out, 'field-stop.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', minify: true,
    alias: { 'next/link': resolve('scripts/harness-link-stub.tsx'), 'next/navigation': resolve('scripts/qb-next-stub.ts') },
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_SUPABASE_URL': '"https://placeholder.supabase.co"',
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': '"placeholder-anon-key-for-preview-only"' },
  })
  copyFileSync('src/app/fonts/dm-sans.ttf', join(out, 'dm-sans.ttf'))
  copyFileSync('src/app/fonts/syne.ttf', join(out, 'syne.ttf'))
  for (const [name, job] of [['typical', typicalJob], ['stress', fixtureJob]] as const) {
  writeFileSync(join(out, name === 'typical' ? 'index.html' : 'stress.html'), `<!doctype html><html lang="en" data-theme="dark" data-preview-scenario="${name}"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>EdgeQuote day notes — local preview</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; img-src 'self' data:; font-src 'self'">
    <link rel="stylesheet" href="preview.css"><style>
    @font-face{font-family:DM Sans;src:url(dm-sans.ttf)}@font-face{font-family:Syne;src:url(syne.ttf)}
    :root{--font-dm-sans:'DM Sans';--font-syne:'Syne'}body{margin:0;font-family:var(--font-dm-sans),sans-serif}
    .preview-header,.preview-main{max-width:1100px;margin:auto;padding:16px}.preview-header p{font-size:14px;line-height:1.6;color:rgb(var(--c-ink-muted))}
    .preview-main{padding-bottom:180px}.preview-header h1{font-size:24px;line-height:1.3}
    </style></head><body><header class="preview-header"><h1>Day-view notes preview</h1><p>Fictional jobs · local preview · business actions are inactive. The mobile stop-details control is interactive.</p></header>
    <main class="preview-main" id="day-board-preview">${renderBoard(job)}</main><div id="field-stop-preview"></div>
    <script src="field-stop.js"></script></body></html>`)
  }
  console.log(`Preview written to ${out}`)
}
void main()
