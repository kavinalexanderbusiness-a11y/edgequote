// ── Verify: does the AI actually describe THIS business? ─────────────────────
//   npm run verify:ai-context
//
// WHY THIS SCRIPT EXISTS
// A bad prompt does not throw. It returns fluent, confident, subtly-wrong text —
// so tsc and next build both pass while the AI quietly writes about lawns for a
// plumber. There is no other way to catch that than to look at the prompt.
//
// It renders the REAL brandVoicePromptBlock (no copies, no mocks of our own code)
// for a lawn business and a non-lawn business, and asserts the difference. No API
// key, no network, no cost, and fully deterministic — so it can run in CI beside
// the other verifiers.

import { brandVoicePromptBlock, BANNED_PHRASES, type BrandVoice } from '../src/lib/marketing/brandVoice'
import { contextLine, looksSeasonal, EMPTY_CONTEXT, type BusinessContext } from '../src/lib/marketing/businessContext'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => cond ? ok(name) : fail(name, detail)

const base: BrandVoice = {
  businessName: 'Acme', ownerName: 'Sam', phone: '555-0100', website: null,
  email: null, city: 'Calgary', reviewUrl: null,
}

// Real shapes, taken from what production actually holds (service_templates.name).
const LAWN = ['Weekly Mowing', 'Bi-Weekly Mowing', 'Lawn Mowing', 'Bush Shaping', 'Spring Cleanup']
const PLUMBER = ['Drain Cleaning', 'Water Heater Install', 'Leak Repair', 'Emergency Callout']
const ELECTRICIAN = ['Panel Upgrade', 'EV Charger Install', 'Lighting Retrofit']

const ctx = (services: string[]): BusinessContext =>
  ({ services, categories: [], descriptions: [], empty: services.length === 0 })

console.log('\n── Prompt: LAWN business ───────────────────────────────────────')
const lawnPrompt = brandVoicePromptBlock({ ...base, services: LAWN })
console.log(lawnPrompt.split('\n').map(l => '  ' + l).join('\n'))

console.log('\n── Prompt: PLUMBER ─────────────────────────────────────────────')
const plumbPrompt = brandVoicePromptBlock({ ...base, services: PLUMBER })
console.log(plumbPrompt.split('\n').map(l => '  ' + l).join('\n'))

console.log('\n── Prompt: business we know NOTHING about ──────────────────────')
const unknownPrompt = brandVoicePromptBlock({ ...base, services: [] })
console.log(unknownPrompt.split('\n').map(l => '  ' + l).join('\n'))

console.log('\n── Assertions ─────────────────────────────────────────────────')

// 1. The lawn business is still described as lawn — DERIVED, not assumed.
//    (The whole point: generalizing must not cost lawn companies anything.)
check('lawn prompt names its real services',
  LAWN.every(s => lawnPrompt.includes(s)),
  'a service the owner configured is missing from the prompt')

// 2. The plumber is described as a plumber, and lawn NEVER appears.
check('plumber prompt names its real services',
  PLUMBER.every(s => plumbPrompt.includes(s)),
  'a configured service is missing')
check('plumber prompt contains NO lawn language',
  !/lawn|mow|grass|yard|turf/i.test(plumbPrompt),
  `leaked trade language:\n${plumbPrompt}`)
check('electrician prompt contains NO lawn language',
  !/lawn|mow|grass|snow/i.test(brandVoicePromptBlock({ ...base, services: ELECTRICIAN })),
  'leaked trade language')

// 3. The model is told not to invent a trade.
check('prompt forbids inventing services',
  /never mention a trade or service they do not sell/i.test(plumbPrompt),
  'the "only these services" instruction is missing')

// 4. Unknown → SILENCE, never an assumed trade. This is the failure this replaces.
check('unknown business asserts no trade at all',
  !/services they sell/i.test(unknownPrompt) && !/lawn|mow/i.test(unknownPrompt),
  `we invented a trade from nothing:\n${unknownPrompt}`)
check('contextLine() returns null when unknown',
  contextLine(EMPTY_CONTEXT) === null,
  'an unknown business produced a context line')

// 5. The banned-phrase system is INTACT. It is a quality filter, not an
//    assumption — deleting it would make lawn captions worse.
check('banned-phrase list still present',
  Array.isArray(BANNED_PHRASES) && BANNED_PHRASES.length > 0,
  'the banned list is gone or empty')
check('banned list still bans the lawn clichés it was written for',
  BANNED_PHRASES.some(p => /lawn/i.test(p)),
  'lawn cliché bans were stripped — lawn caption quality would regress')

// 6. Seasonality is DERIVED from the owner's own services, not assumed.
check('lawn business reads as seasonal', looksSeasonal(ctx(LAWN)), '')
check('snow business reads as seasonal', looksSeasonal(ctx(['Snow Removal', 'Ice Control'])), '')
check('plumber does NOT read as seasonal', !looksSeasonal(ctx(PLUMBER)),
  'a non-seasonal trade would be offered Spring Cleanup campaigns')
check('electrician does NOT read as seasonal', !looksSeasonal(ctx(ELECTRICIAN)), '')
// Unknown must stay seasonal: losing a campaign is a regression, showing a
// spurious one is an annoyance. Fail toward the annoyance.
check('unknown business stays seasonal (fails safe)', looksSeasonal(EMPTY_CONTEXT),
  'an unreadable business would silently lose its seasonal campaigns')

console.log(failures === 0
  ? '\n✓ AI business context verified for lawn and non-lawn businesses.\n'
  : `\n✗ ${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
