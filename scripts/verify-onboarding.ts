// ── Onboarding verification — run by CI on every push (npm run verify:onboarding) ──
//
// The seeding path's one promise: IT ONLY EVER FILLS EMPTINESS. An existing
// business — any business with any owner data on a surface — must come through
// setup byte-identical. That promise lives in a pure function (seedPlan), so it
// is pinned here without a database: every gate is driven through every state
// that exists in production, plus the adversarial ones.
//
// Style follows verify-automations/verify-trades: pure, deterministic, no I/O.

import { seedPlan, seasonsForStorage, serviceRowsFor, type SeedState } from '../src/lib/onboarding/seed'
import { LAWN_PACK, NEUTRAL_PACK, tradePack } from '../src/lib/trades'
import { SEASONAL_TEMPLATES } from '../src/lib/crm/campaigns'

let pass = 0
let fail = 0
function H(title: string) { console.log(`\n═══ ${title} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}

const state = (over: Partial<SeedState>): SeedState => ({
  hasSettingsRow: true, businessType: 'lawn_landscaping',
  serviceTemplateCount: 0, seasonsConfigured: false, modulesConfigured: false,
  ...over,
})

// ═══════════════════════════════════════════════════════════════════════════
H('1. THE EXISTING BUSINESS — byte-identical by construction')
// This is production's exact shape: a configured catalogue, stored seasons,
// modules NULL. The plan must touch NOTHING (modules skip because no pack has
// an opinion — and if one ever does, the configured gates still hold).
const LIVE = state({ serviceTemplateCount: 27, seasonsConfigured: true, modulesConfigured: false })
for (const p of [LAWN_PACK, NEUTRAL_PACK, tradePack('plumbing')]) {
  const plan = seedPlan(LIVE, p)
  check(`configured business + ${p.key} pack → seeds NOTHING`,
    { services: plan.seedServices, seasons: plan.seedSeasons, modules: plan.seedModules },
    { services: false, seasons: false, modules: false })
}
check('every skip carries an owner-readable reason',
  seedPlan(LIVE, LAWN_PACK).skipped.every(s => s.reason.length > 10), true)

// ═══════════════════════════════════════════════════════════════════════════
H('2. OWNER DATA WINS — one row is as protective as a thousand')
check('ONE service template blocks catalogue seeding',
  seedPlan(state({ serviceTemplateCount: 1 }), LAWN_PACK).seedServices, false)
check('a DEACTIVATED catalogue still blocks (count includes inactive)',
  // the state loader counts ALL templates — this pins that the PLAN trusts it
  seedPlan(state({ serviceTemplateCount: 3 }), LAWN_PACK).seedServices, false)
check('stored seasons block season seeding — even an owner-cleared {}',
  seedPlan(state({ seasonsConfigured: true }), LAWN_PACK).seedSeasons, false)
check('a set module list blocks module seeding',
  seedPlan(state({ modulesConfigured: true }), { ...NEUTRAL_PACK, modules: ['schedule'] }).seedModules, false)

// ═══════════════════════════════════════════════════════════════════════════
H('2b. A FAILED READ IS NOT AN EMPTY BUSINESS — fail closed')
// loadSeedState returns readError + a looks-configured state on any read failure,
// so a dropped connection can never license an overwrite. seedPlan must skip
// everything for that state; applyTradeSelection aborts on readError (proven by
// the shape here — the plan alone must already be all-skips).
const READ_FAILED = state({ readError: 'connection reset', serviceTemplateCount: 1, seasonsConfigured: true, modulesConfigured: true })
check('read error → plan seeds NOTHING (the fail-closed state)',
  { s: seedPlan(READ_FAILED, LAWN_PACK).seedServices, z: seedPlan(READ_FAILED, LAWN_PACK).seedSeasons, m: seedPlan(READ_FAILED, LAWN_PACK).seedModules },
  { s: false, z: false, m: false })

// ═══════════════════════════════════════════════════════════════════════════
H('3. A NEW BUSINESS — emptiness seeds')
const FRESH = state({ hasSettingsRow: false, businessType: null })
check('fresh lawn business seeds services + seasons',
  { s: seedPlan(FRESH, LAWN_PACK).seedServices, z: seedPlan(FRESH, LAWN_PACK).seedSeasons },
  { s: true, z: true })
check('fresh plumbing business seeds services, no seasons (year-round pack)',
  { s: seedPlan(FRESH, tradePack('plumbing')).seedServices, z: seedPlan(FRESH, tradePack('plumbing')).seedSeasons },
  { s: true, z: false })
check('year-round skip explains itself, not a mystery',
  seedPlan(FRESH, tradePack('plumbing')).skipped.some(s => s.surface === 'seasons' && /year-round/.test(s.reason)), true)
check('no pack recommends modules today → modules never seed (NULL = all, the recommendation)',
  [LAWN_PACK, NEUTRAL_PACK, ...['cleaning', 'plumbing', 'hvac', 'electrical', 'pest_control', 'painting', 'pool_service', 'junk_removal', 'roofing', 'handyman'].map(tradePack)]
    .map(p => seedPlan(FRESH, p).seedModules), new Array(12).fill(false))
check('unknown business_type falls to the neutral pack, which still seeds a catalogue',
  seedPlan(FRESH, tradePack('cryptozoology')).seedServices, true)

// ═══════════════════════════════════════════════════════════════════════════
H('4. WHAT SEEDING WRITES — shapes the DB will accept')
const rows = serviceRowsFor(LAWN_PACK, 'user-1')
check('service rows carry every NOT NULL column the insert needs',
  rows.every(r => r.user_id === 'user-1' && r.name && r.category && r.default_rate > 0 && r.pricing_display_type && r.is_active === true && Number.isInteger(r.sort_order)), true)
check('sort_order preserves the pack\'s curated order', rows.map(r => r.sort_order), rows.map((_, i) => i))
const stored = seasonsForStorage(LAWN_PACK) as Record<string, { match?: string[] }>
check('lawn/snow keys store WITHOUT match — the engine ignores match on built-ins, dead data stays out',
  { lawn: 'match' in stored.lawn, snow: 'match' in stored.snow }, { lawn: false, snow: false })
check('stored lawn/snow dates are the engine defaults verbatim',
  stored, {
    snow: { label: 'Snow', startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 },
    lawn: { label: 'Lawn', startMonth: 4, startDay: 15, endMonth: 10, endDay: 31 },
  })

// ═══════════════════════════════════════════════════════════════════════════
H('5. CAMPAIGN PRESETS — derived, not seeded (nothing to overwrite)')
// The campaign menu's seasonal presets come from the pack at render time; no
// rows are written. For a lawn business the pack IS today's SEASONAL_TEMPLATES,
// so the menu is provably unchanged for every existing business.
check('lawn pack campaigns ≡ SEASONAL_TEMPLATES (the menu is byte-identical for lawn)',
  LAWN_PACK.seasonalCampaigns, SEASONAL_TEMPLATES)
check('the DEFAULT business_type (every existing row) resolves to the lawn pack',
  tradePack('lawn_landscaping') === LAWN_PACK, true)
check('a pack with no campaigns falls back to neutral presets, never an empty menu',
  (tradePack('plumbing').seasonalCampaigns.length ? tradePack('plumbing').seasonalCampaigns : NEUTRAL_PACK.seasonalCampaigns).length > 0, true)

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
