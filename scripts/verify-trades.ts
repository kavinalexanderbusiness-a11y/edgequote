// ── Trade-pack verification — run by CI on every push (npm run verify:trades) ──
//
// Two promises hold the vertical foundation together, and this script is where
// they stop being comments and start being build failures:
//
//   1. GOLDEN: the lawn pack is behaviour-identical to today's engine constants.
//      Its seasons/hints are deep-equalled against lib/seasons.ts and probed
//      through the REAL serviceCategory(); its campaign presets are deep-equalled
//      against lib/crm/campaigns.ts SEASONAL_TEMPLATES. The pack carries verbatim
//      COPIES (so lib/trades can import nothing) — a copy that drifts fails here.
//
//   2. CLOSURE: business_type selects seed data and copy, never behaviour. So
//      lib/trades must import NOTHING outside itself, and nothing in src/ may
//      import lib/trades except an explicit allowlist (empty in Phase 2 — the
//      pack has zero importers until the seeding phase lands). Engines can never
//      appear in that allowlist: a hard blocklist of engine paths is checked
//      against it, so even a careless future edit can't hand a pack to pricing.
//
// Style follows scripts/verify-automations.ts: pure functions, no network, no
// database — every check is deterministic and runs in milliseconds.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { TRADE_PACKS, LAWN_PACK, NEUTRAL_PACK, tradePack, DEFAULT_BUSINESS_TYPE } from '../src/lib/trades'
import type { TradePack } from '../src/lib/trades'
import { serviceCategory, DEFAULT_SEASONS } from '../src/lib/seasons'
import { SEASONAL_TEMPLATES } from '../src/lib/crm/campaigns'

let pass = 0
let fail = 0

function H(title: string) {
  console.log(`\n═══ ${title} ═══`)
}
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
H('1. GOLDEN — the lawn pack IS today\'s season constants')
// Pinned as LITERALS, not just cross-references: if someone changes the engine
// AND the pack together, these still catch it and force the change to be said
// out loud here — three places must agree before behaviour moves.
const LAWN_HINTS = ['mow', 'lawn', 'fertiliz', 'fertilis', 'grass', 'aerat', 'trim', 'edge']
const SNOW_HINTS = ['snow', 'ice', 'plow', 'plough', 'salt', 'shovel']

check('lawn season dates = Apr 15 → Oct 31 (DEFAULT_LAWN_SEASON verbatim)',
  { s: LAWN_PACK.seasons.lawn.startMonth, sd: LAWN_PACK.seasons.lawn.startDay, e: LAWN_PACK.seasons.lawn.endMonth, ed: LAWN_PACK.seasons.lawn.endDay },
  { s: 4, sd: 15, e: 10, ed: 31 })
check('snow season dates = Nov 1 → Mar 31 (DEFAULT_SNOW_SEASON verbatim)',
  { s: LAWN_PACK.seasons.snow.startMonth, sd: LAWN_PACK.seasons.snow.startDay, e: LAWN_PACK.seasons.snow.endMonth, ed: LAWN_PACK.seasons.snow.endDay },
  { s: 11, sd: 1, e: 3, ed: 31 })
check('lawn match hints verbatim', LAWN_PACK.seasons.lawn.match, LAWN_HINTS)
check('snow match hints verbatim', LAWN_PACK.seasons.snow.match, SNOW_HINTS)
check('pack dates equal the ENGINE\'s DEFAULT_SEASONS (both sides pinned)',
  { lawn: DEFAULT_SEASONS.lawn, snow: DEFAULT_SEASONS.snow },
  {
    lawn: { startMonth: LAWN_PACK.seasons.lawn.startMonth, startDay: LAWN_PACK.seasons.lawn.startDay, endMonth: LAWN_PACK.seasons.lawn.endMonth, endDay: LAWN_PACK.seasons.lawn.endDay },
    snow: { startMonth: LAWN_PACK.seasons.snow.startMonth, startDay: LAWN_PACK.seasons.snow.startDay, endMonth: LAWN_PACK.seasons.snow.endMonth, endDay: LAWN_PACK.seasons.snow.endDay },
  })
check('snow is declared before lawn (match precedence mirrors the engine)',
  Object.keys(LAWN_PACK.seasons), ['snow', 'lawn'])

// The pack's match data must CLASSIFY exactly as the live engine does. A tiny
// matcher over pack data (first season whose hint hits, insertion order) is run
// against the real serviceCategory() for every realistic shape of name — plus
// the pathological both-match case, pinning the engine's snow-first rule.
function packCategory(name: string | null | undefined): string {
  const s = (name || '').toLowerCase()
  for (const [key, season] of Object.entries(LAWN_PACK.seasons)) {
    if (season.match.some(h => s.includes(h))) return key
  }
  return 'year_round'
}
const PROBES = [
  'Weekly Mowing', 'Bi-Weekly Mowing', 'One-Time Mowing', 'Monthly Lawn Care',
  'Fertilization', 'Core Aeration', 'Overseeding', 'String Trimming', 'Lawn Edging',
  'Hedge Trimming', 'Grass Cutting',
  'Snow Removal', 'Snow Blowing', 'Ice Management', 'Salting', 'Driveway Plowing', 'Sidewalk Shovelling',
  'Gutter Cleaning', 'Pressure Washing', 'Window Cleaning', 'Pool Opening', 'Drain Cleaning',
  'Duct Cleaning', 'Junk Removal', 'Roof Repair', 'Interior Painting',
  'Snow clearing for lawn customers', // both-match: engine says snow (checked first)
  '', null, undefined,
]
for (const p of PROBES) {
  check(`classifies like the engine: ${JSON.stringify(p ?? String(p))} → ${serviceCategory(p)}`,
    packCategory(p), serviceCategory(p))
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. GOLDEN — the lawn pack IS today\'s seasonal campaign presets')
check('five presets, byte-identical to SEASONAL_TEMPLATES (keys, dates, copy, channels)',
  LAWN_PACK.seasonalCampaigns, SEASONAL_TEMPLATES)

// ═══════════════════════════════════════════════════════════════════════════
H('3. REGISTRY — lookup fails safe, keys fit the DB constraint')
check('DEFAULT_BUSINESS_TYPE is the founding trade', DEFAULT_BUSINESS_TYPE, 'lawn_landscaping')
check('the default resolves to the lawn pack', tradePack(DEFAULT_BUSINESS_TYPE) === LAWN_PACK, true)
check('unknown key → neutral pack, never a crash, never lawn copy', tradePack('cryptozoology') === NEUTRAL_PACK, true)
check('null → neutral', tradePack(null) === NEUTRAL_PACK, true)
check('undefined → neutral', tradePack(undefined) === NEUTRAL_PACK, true)
check('empty string → neutral', tradePack('') === NEUTRAL_PACK, true)
check('the neutral pack is itself pickable', tradePack('general') === NEUTRAL_PACK, true)
check('every key satisfies the DB CHECK ^[a-z][a-z0-9_]*$',
  TRADE_PACKS.filter(p => !/^[a-z][a-z0-9_]*$/.test(p.key)).map(p => p.key), [])
check('keys are unique', new Set(TRADE_PACKS.map(p => p.key)).size, TRADE_PACKS.length)
check('the named trades are all registered',
  ['lawn_landscaping', 'cleaning', 'plumbing', 'hvac', 'electrical', 'pest_control', 'painting', 'pool_service', 'junk_removal', 'roofing', 'handyman', 'general']
    .filter(k => !TRADE_PACKS.some(p => p.key === k)), [])
check('picker order: founding trade first, general last',
  [TRADE_PACKS[0].key, TRADE_PACKS[TRADE_PACKS.length - 1].key], ['lawn_landscaping', 'general'])

// ═══════════════════════════════════════════════════════════════════════════
H('4. PACK SANITY — every pack, every service, every season, every preset')
const DISPLAY_TYPES = ['starting_from', 'hourly', 'per_sqft', 'per_linear_ft', 'starting_from_materials', 'hourly_materials']
function packDefects(p: TradePack): string[] {
  const d: string[] = []
  if (!p.label.trim() || !p.blurb.trim()) d.push('label/blurb empty')
  if (p.services.length < 1 || p.services.length > 20) d.push(`service count ${p.services.length}`)
  const seen = new Set<string>()
  for (const s of p.services) {
    const tag = `"${s.name}"`
    if (!s.name.trim() || !s.category.trim()) d.push(`${tag}: empty name/category`)
    if (seen.has(s.name.toLowerCase())) d.push(`${tag}: duplicate name`)
    seen.add(s.name.toLowerCase())
    // numeric(8,2): six integer digits max — and a rate of 0 reads as broken seed data.
    if (!Number.isFinite(s.default_rate) || s.default_rate <= 0 || s.default_rate > 999999.99) d.push(`${tag}: rate ${s.default_rate}`)
    if (!DISPLAY_TYPES.includes(s.pricing_display_type)) d.push(`${tag}: display type ${s.pricing_display_type}`)
    if ((s.default_description ?? '').length > 200) d.push(`${tag}: description over 200 chars`)
  }
  for (const [key, sn] of Object.entries(p.seasons)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) d.push(`season key ${key} malformed`)
    if (sn.startMonth < 1 || sn.startMonth > 12 || sn.endMonth < 1 || sn.endMonth > 12) d.push(`season ${key}: month out of range`)
    if (sn.startDay < 1 || sn.startDay > 31 || sn.endDay < 1 || sn.endDay > 31) d.push(`season ${key}: day out of range`)
    if (!sn.match.length || sn.match.some(m => !m.trim() || m !== m.toLowerCase())) d.push(`season ${key}: match hints must be non-empty lowercase`)
  }
  for (const c of p.seasonalCampaigns) {
    if (!/^[a-z][a-z0-9_]*$/.test(c.key)) d.push(`campaign ${c.key}: malformed key`)
    if (c.month < 1 || c.month > 12 || c.day < 1 || c.day > 28) d.push(`campaign ${c.key}: send date must exist every year`)
    if (c.channels.some(ch => ch !== 'sms' && ch !== 'email')) d.push(`campaign ${c.key}: unknown channel`)
    if (!c.body.includes('{{business_name}}')) d.push(`campaign ${c.key}: body missing {{business_name}} sign-off`)
    if (!c.body.includes('{{first_name}}')) d.push(`campaign ${c.key}: body missing {{first_name}} greeting`)
  }
  return d
}
for (const p of TRADE_PACKS) check(`${p.key} is well-formed seed data`, packDefects(p), [])

// ═══════════════════════════════════════════════════════════════════════════
H('5. CLOSURE — packs are data, and no engine can ever hold one')
// (a) lib/trades imports NOTHING outside itself. "Pure data layer" as a
//     structural fact: every import specifier must be intra-module ('./…').
const SRC = join(__dirname, '..', 'src')
const TRADES_DIR = join(SRC, 'lib', 'trades')
const IMPORT_RE = /(?:import|export)\s+[^'"]*?from\s+['"]([^'"]+)['"]/g

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const externalImports: string[] = []
for (const f of walk(TRADES_DIR)) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(IMPORT_RE)) {
    if (!m[1].startsWith('./')) externalImports.push(`${relative(SRC, f)} → ${m[1]}`)
  }
}
check('lib/trades imports nothing outside itself', externalImports, [])

// (b) Nothing in src/ imports lib/trades except the allowlist. Grows ONLY when
//     a seeding/onboarding phase lands, in a reviewed change to this file.
const ALLOWED_IMPORTERS: string[] = [
  // Phase 2: the pack has ZERO importers. Phase 4/5 adds the settings picker
  // and the seeding module here — and nothing else, ever. Engines are blocked
  // below regardless of what this list says.
]
// Paths that may NEVER import lib/trades, whatever the allowlist claims.
// This is the "no engine branches on trade" rule as code.
const ENGINE_PATHS = [
  'lib/pricing', 'lib/optimizer', 'lib/seasons', 'lib/recurrence', 'lib/invoicing',
  'lib/comms/', 'lib/automation/', 'lib/signals/', 'lib/payments/', 'lib/crm/',
  'lib/suggestions', 'lib/revenueIntelligence', 'lib/businessIntelligence',
  'lib/customerHealth', 'lib/jobPricing', 'lib/duration', 'lib/labor',
  'lib/scheduleHealth', 'lib/dayStatus', 'lib/ai/', 'app/api/',
]
const importers: string[] = []
for (const f of walk(SRC)) {
  if (f.startsWith(TRADES_DIR)) continue
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[1].startsWith('@/lib/trades') || /(^|\/)lib\/trades(\/|$)/.test(m[1]) || m[1].includes('../trades')) {
      importers.push(relative(SRC, f).replace(/\\/g, '/'))
    }
  }
}
check('importers of lib/trades ⊆ allowlist (empty in Phase 2)',
  importers.filter(f => !ALLOWED_IMPORTERS.includes(f)), [])
check('the allowlist itself contains no engine path (defense in depth)',
  ALLOWED_IMPORTERS.filter(a => ENGINE_PATHS.some(e => a.includes(e))), [])
check('no engine file imports lib/trades',
  importers.filter(f => ENGINE_PATHS.some(e => f.includes(e))), [])

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
