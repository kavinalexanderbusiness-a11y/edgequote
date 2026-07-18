// ── Verify: ONE assistant, not twelve buttons ────────────────────────────────
//   npm run verify:ai-surface
//
// WHY THIS SCRIPT EXISTS
// "There is one AI pipeline, one loading pattern, one streaming pattern" is an
// architectural claim, and architecture rots silently: nothing fails when the
// next AI button is added with its own fetch loop, its own spinner and its own
// wording. tsc and next build are both perfectly happy with a second copy of a
// transport. So the claim is asserted here, over the real source, and it fails
// the build when it stops being true.
//
// This is a STRUCTURAL test — it reads the source of every AI surface and
// asserts the shape of it. It is deliberately allowed to be annoying: if you
// genuinely need a new AI affordance, add it to the kit, not beside it.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)

const SRC = join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const FILES = walk(SRC)
const read = (p: string) => readFileSync(p, 'utf8')
const rel = (p: string) => p.slice(SRC.length + 1).replace(/\\/g, '/')

// Every file that talks to an AI route or gateway.
const aiFiles = FILES.filter(f => {
  const s = read(f)
  return /\/api\/ai\/|\/api\/marketing\/(generate|rewrite|queue|campaign)|before-after\/select|lib\/ai\//.test(s)
})

console.log('\n── One streaming pattern ──────────────────────────────────────')

// THE test. A hand-rolled reader is `getReader()` + a newline scan; the only
// place allowed to do that is the shared transport.
const readers = FILES.filter(f =>
  /getReader\(\)/.test(read(f)) && /indexOf\('\\n'\)|indexOf\("\\n"\)/.test(read(f)))
check('exactly ONE NDJSON reader exists',
  readers.length === 1 && rel(readers[0]) === 'lib/ai/stream.ts',
  `found ${readers.length}: ${readers.map(rel).join(', ') || 'none'} — a second reader is a second product`)

// Same for the server half: nobody builds their own NDJSON stream + headers.
const emitters = FILES.filter(f => {
  const s = read(f)
  return /new ReadableStream/.test(s) && /application\/x-ndjson/.test(s)
})
check('exactly ONE NDJSON emitter exists',
  emitters.length === 1 && rel(emitters[0]) === 'lib/ai/stream.ts',
  `found ${emitters.length}: ${emitters.map(rel).join(', ') || 'none'}`)

// The headers are load-bearing (no-transform / X-Accel-Buffering keep proxies
// from buffering the stream into a single paste). They live in ONE place.
const headerCopies = FILES.filter(f => /X-Accel-Buffering/.test(read(f)))
check('the NDJSON headers are stated once',
  headerCopies.length === 1 && rel(headerCopies[0]) === 'lib/ai/stream.ts',
  `found in ${headerCopies.length}: ${headerCopies.map(rel).join(', ')}`)

// Both streaming routes must go through it.
for (const r of ['app/api/ai/assist/route.ts', 'app/api/marketing/generate/stream/route.ts']) {
  const s = read(join(SRC, r))
  check(`${r.split('/').slice(2, -1).join('/')} streams through the shared transport`,
    /ndjsonResponse/.test(s) && !/new ReadableStream/.test(s),
    'this route still builds its own stream')
}

console.log('\n── One AI pipeline ────────────────────────────────────────────')

// Two gateways is the DELIBERATE split (text vs multimodal); a third is not.
const gateways = FILES.filter(f => /api\.anthropic\.com/.test(read(f)))
check('exactly TWO Claude gateways (text + multimodal), no third',
  gateways.length === 2,
  `found ${gateways.length}: ${gateways.map(rel).join(', ')}`)

// No component may reach the model except through a route.
const clientDirect = FILES.filter(f => /^components\//.test(rel(f)) && /api\.anthropic\.com|@anthropic-ai/.test(read(f)))
check('no component calls the model directly', clientDirect.length === 0,
  clientDirect.map(rel).join(', '))

// Every assist task goes through the ONE registry + ONE route.
const assistRoutes = FILES.filter(f => /^app\/api\/ai\//.test(rel(f)))
check('the assist engine has exactly ONE route', assistRoutes.length === 1,
  assistRoutes.map(rel).join(', '))

console.log('\n── One AI button ──────────────────────────────────────────────')

// The kit is the only door. The old single-purpose AssistButton file is gone;
// anything importing it would be importing a file that no longer exists.
check('no import of the removed AssistButton module',
  !FILES.some(f => /components\/ai\/AssistButton/.test(read(f))),
  'a surface still imports the old button path')

// Every AI trigger uses the kit's button. This is what stops the next feature
// shipping a <Button><Sparkles/> Generate thing</Button> of its own.
const AI_TRIGGER_FILES = [
  'components/comms/SendMessageDialog.tsx',
  'components/ai/CustomerAiSummary.tsx',
  'components/customers/ReviewLifecycle.tsx',
  'components/quotes/QuoteBuilder.tsx',
  'components/schedule/JobForm.tsx',
  'components/grow/marketing/ContentComposer.tsx',
  'components/grow/marketing/StudioClient.tsx',
  'components/grow/marketing/IdeasClient.tsx',
  'components/grow/marketing/CampaignBuilder.tsx',
  'components/grow/marketing/MarketingCalendar.tsx',
  'components/grow/beforeafter/BeforeAfterStudio.tsx',
]
for (const f of AI_TRIGGER_FILES) {
  const s = read(join(SRC, f))
  check(`${f.split('/').pop()} triggers AI via the shared button`,
    /AssistButton/.test(s) && /@\/components\/ai\/ui/.test(s),
    'this surface still rolls its own AI trigger')
}

// The icon means AI, so the label must not also say so.
const withAiLabel = AI_TRIGGER_FILES.filter(f =>
  /label=["'][^"']*\bwith AI\b/i.test(read(join(SRC, f))))
check('no button label says "with AI" (the sparkle already does)',
  withAiLabel.length === 0, withAiLabel.join(', '))

console.log('\n── One loading pattern ────────────────────────────────────────')

// Busy state is the button's job. A caller writing `label={x ? 'Writing…' : …}`
// is re-inventing busyLabel and will drift.
const ternaryLabels = AI_TRIGGER_FILES.filter(f =>
  /label=\{[^}]*\?[^}]*…/.test(read(join(SRC, f))))
check('no surface hand-rolls a busy label ternary',
  ternaryLabels.length === 0,
  `${ternaryLabels.join(', ')} — use busyLabel instead`)

// Every busy label is the -ing form, so "working" always reads the same way.
const KIT = read(join(SRC, 'components/ai/ui.tsx'))
check('the shared button owns the busy swap',
  /busy \? \(busyLabel \|\| label\) : label/.test(KIT),
  'the button no longer swaps its own label')

console.log('\n── One way to stop, and one way to undo ───────────────────────')

// `cancel` was exported by the hook from day one and called by NOTHING.
const stops = AI_TRIGGER_FILES.filter(f => /AiStop/.test(read(join(SRC, f))))
check('every streaming surface can be stopped',
  stops.length >= 6,
  `only ${stops.length} surfaces expose Stop: ${stops.join(', ')}`)
check('the assist hook\'s cancel is actually wired',
  FILES.some(f => /ai\.cancel|aiScope\.cancel|aiNotes\.cancel/.test(read(f))),
  'cancel is exported and still called by nobody')

// Destructive replaces must be reversible. These three blank a field the owner
// may have typed into.
for (const f of ['components/comms/SendMessageDialog.tsx', 'components/quotes/QuoteBuilder.tsx', 'components/schedule/JobForm.tsx']) {
  check(`${f.split('/').pop()} can undo an AI replace`,
    /toast\.undo/.test(read(join(SRC, f))),
    'this surface destroys the owner\'s text with no way back')
}

console.log('\n── One error treatment, one explanation ───────────────────────')

// Errors: one component, so role="alert" can't be forgotten (it was, once).
const rawErrors = AI_TRIGGER_FILES.filter(f => {
  const s = read(join(SRC, f))
  return /(ai|aiScope|aiNotes|gen)\.?[Ee]rror\s*&&\s*</.test(s)
})
check('no surface hand-rolls an AI error line',
  rawErrors.length === 0,
  `${rawErrors.join(', ')} — use <AiError />`)
check('the error component announces itself',
  /role="alert"/.test(KIT), 'AiError lost role="alert"')

// Explainability: the engine computes real facts (a balance, a cadence, the
// owner's own line-item notes) and the UI used to say nothing about any of it.
const explained = AI_TRIGGER_FILES.filter(f => /AiNote/.test(read(join(SRC, f))))
check('the assist surfaces explain what they read',
  explained.length >= 5,
  `only ${explained.length} explain themselves: ${explained.join(', ')}`)

// Anything a CUSTOMER reads says so, in the same words everywhere.
check('the check-it-first wording is stated once',
  (KIT.match(/AI draft — read it before it goes out\./g) || []).length === 1,
  'the disclaimer wording is duplicated or gone')
for (const f of ['components/comms/SendMessageDialog.tsx', 'components/quotes/QuoteBuilder.tsx']) {
  check(`${f.split('/').pop()} warns before customer-facing text goes out`,
    /AI_CHECK_FIRST/.test(read(join(SRC, f))),
    'customer-facing AI text carries no draft warning')
}

console.log('\n── The engine is untouched ────────────────────────────────────')

// The whole point of the chosen scope: unify the EXPERIENCE, not the engine.
// If this fails, the marketing rebuild we deliberately avoided has crept in.
check('marketing still owns its own prompts',
  /buildPostStreamInput|buildPostInput/.test(read(join(SRC, 'app/api/marketing/generate/stream/route.ts'))),
  'marketing generation was rerouted through the assist engine')
check('marketing still scores and re-polishes its own drafts',
  /scorePost/.test(read(join(SRC, 'app/api/marketing/generate/stream/route.ts'))),
  'the quality loop was lost')
// Assert the REGISTRY's contents, not the word "marketing" — assist legitimately
// reads lib/marketing/businessContext for the owner's service catalog, and an
// earlier version of this check failed on that import alone. What must not
// happen is a marketing GENERATION task appearing in the assist registry.
const TASKS = read(join(SRC, 'app/api/ai/assist/route.ts')).match(/const TASKS[^=]*=\s*\[([^\]]*)\]/)?.[1] || ''
const taskList = TASKS.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
// NOT a fixed count — new in-app assist tasks are exactly what this registry is
// for, and asserting "five forever" made a correctly-placed addition
// (quote_intelligence) look like an architecture violation. The invariant is
// narrower and permanent: marketing GENERATION must not move in here, because
// that engine owns its own prompts, scoring and persistence.
check('the assist registry holds only in-app assist tasks',
  taskList.length > 0 && !taskList.some(t => /caption|hashtag|post|campaign|marketing|channel/i.test(t)),
  `registry is now: ${taskList.join(', ')} — marketing generation must not move in here`)

console.log(`\n  (${aiFiles.length} files touch AI)`)
console.log(failures === 0
  ? '\n✓ One assistant: one pipeline, one stream, one button, one stop, one undo.\n'
  : `\n✗ ${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
