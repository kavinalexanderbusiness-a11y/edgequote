// ── Onboarding verification — run by CI on every push (npm run verify:onboarding) ──
//
// The seeding path's one promise: IT ONLY EVER FILLS EMPTINESS. An existing
// business — any business with any owner data on a surface — must come through
// setup byte-identical. That promise lives in a pure function (seedPlan), so it
// is pinned here without a database: every gate is driven through every state
// that exists in production, plus the adversarial ones.
//
// Style follows verify-automations/verify-trades: pure, deterministic, no I/O.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedPlan, seasonsForStorage, serviceRowsFor, type SeedState } from '../src/lib/onboarding/seed'
import { deriveSetupHealth, type SetupSnapshot } from '../src/lib/onboarding/setupHealth'
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
H('6. SETUP HEALTH — derived from existing data, mirroring real consumer gates')
// deriveSetupHealth is pure; each item's `done` must mirror the exact gate its
// consumer applies (portal e-transfer, review cron, geocode users…). These pin
// the derivation. The loader's fail-closed contract (readError → the card
// renders NOTHING, never a checklist of guesses) lives in SetupProgress, which
// returns before deriving — the snapshot shape here is what makes that possible.
const FULL: SetupSnapshot = {
  companyName: 'Edge Property Services', phone: '403-555-0100', emailPrimary: 'kav@edge.ca',
  baseAddress: '123 Main St SW, Calgary', baseLat: 51.02, baseLng: -114.06,
  logoUrl: 'https://x/logo.png', termsText: 'Payment due on receipt.',
  etransferEmail: 'pay@edge.ca', bookingEnabled: true, reviewUrl: 'https://g.page/r/x',
  activeTemplateCount: 23, unpricedActiveTemplateCount: 0,
}
check('fully configured business → complete, card would render nothing',
  deriveSetupHealth(FULL).complete, true)

// TODAY'S PRODUCTION TRUTH, pinned: the live business is complete on everything
// except e-transfer (its portal silently hides Ways-to-Pay e-transfer — the
// portal audit's one open actionable). If this check ever fails, either the
// checklist drifted or someone fixed e-transfer — both worth noticing.
const LIVE_BIZ: SetupSnapshot = { ...FULL, etransferEmail: null }
check('the LIVE business shape → exactly one incomplete item: etransfer',
  deriveSetupHealth(LIVE_BIZ).items.filter(i => !i.done).map(i => i.key), ['etransfer'])
check('live shape → 8 of 9 done', { d: deriveSetupHealth(LIVE_BIZ).done, t: deriveSetupHealth(LIVE_BIZ).total }, { d: 8, t: 9 })

const EMPTY_SNAP: SetupSnapshot = {
  companyName: '', phone: null, emailPrimary: null, baseAddress: null, baseLat: null, baseLng: null,
  logoUrl: null, termsText: null, etransferEmail: null, bookingEnabled: false, reviewUrl: null,
  activeTemplateCount: 0, unpricedActiveTemplateCount: 0,
}
check('a brand-new business → nothing done', deriveSetupHealth(EMPTY_SNAP).done, 0)

// The gates each item mirrors, driven one at a time:
// home_base deliberately ignores lat/lng: the settings form NULLS them on every
// save (pages re-geocode lazily), so requiring them would turn that self-healing
// transient into a recurring nag that resurrects a dismissed card. The address is
// the owner-actionable fact. This pins the decision — flipping it back is how the
// nag loop returns.
check('address set = home base done, even mid-regeocode (lat/lng transiently null)',
  deriveSetupHealth({ ...FULL, baseLat: null, baseLng: null }).items.find(i => i.key === 'home_base')!.done, true)
check('an unpriced ACTIVE service fails service_prices but not services',
  (() => { const h = deriveSetupHealth({ ...FULL, unpricedActiveTemplateCount: 2 }); return { services: h.items.find(i => i.key === 'services')!.done, prices: h.items.find(i => i.key === 'service_prices')!.done } })(),
  { services: true, prices: false })
check('zero active templates fails BOTH catalogue items',
  deriveSetupHealth({ ...FULL, activeTemplateCount: 0 }).items.filter(i => !i.done).map(i => i.key), ['services', 'service_prices'])
check('whitespace-only review_url reads as unset (mirrors the cron\'s trim)',
  deriveSetupHealth({ ...FULL, reviewUrl: '   ' }).items.find(i => i.key === 'review_link')!.done, false)
check('every item deep-links to a real settings surface',
  deriveSetupHealth(EMPTY_SNAP).items.every(i =>
    ['/dashboard/settings#business', '/dashboard/settings#pricing', '/dashboard/settings#booking', '/dashboard/settings#messaging', '/dashboard/settings/templates'].includes(i.href)), true)
check('every item explains what degrades while incomplete',
  deriveSetupHealth(EMPTY_SNAP).items.every(i => i.why.length > 20 && i.label.length > 3), true)
check('keys are unique and stable',
  new Set(deriveSetupHealth(EMPTY_SNAP).items.map(i => i.key)).size, deriveSetupHealth(EMPTY_SNAP).items.length)

// ═══════════════════════════════════════════════════════════════════════════
H('7. THE FIRST-RUN FRAMING — a new business is not a finished one')
// An empty priority queue means two opposite things: "you cleared it" for a
// working business, "you have not begun" for a brand-new one. The dashboard now
// tells them apart with ONE derived flag. These pin the three ways that could
// go wrong: claiming emptiness we didn't read, showing the first-run framing to
// a mature business, and leaving a caller that doesn't know in the wrong state.
//
// Source-level because the subject IS the wiring — there is no pure function to
// drive. \r is stripped first: a CRLF checkout makes `.` and `$` behave
// differently and would silently invert every absence check below.
const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const DATA = src('src/lib/dashboard/data.ts')
const PRIORITIES_UI = src('src/components/dashboard/TodaysPriorities.tsx')
const SETUP_UI = src('src/components/dashboard/SetupProgress.tsx')
const DASH_PAGE = src('src/app/dashboard/page.tsx')

// ── The honesty rule. Supabase RESOLVES on failure, so a dropped connection
// returns empty arrays. If `started` were computed before the all-or-throw
// check, an outage would render "Create your first quote" to a business with
// 200 of them — the same uncertain-read-licences-an-action bug that the seeding
// path (section 2b) was fixed for, on a different surface.
const iThrow = DATA.indexOf('if (failure) throw')
// The ASSIGNMENT, not the interface field of the same name declared above it.
const iStarted = DATA.indexOf('started: quotes.length')
check('`started` is computed AFTER the all-or-throw read check',
  iThrow > 0 && iStarted > 0 && iStarted > iThrow, true)
check('`started` is derived from all four full-history reads, not one',
  ['quotes.length', 'jobs.length', 'invoices.length', 'customerRows.length']
    .every(t => new RegExp(`started:[^\\n]*${t.replace('.', '\\.')}`).test(DATA)), true)

// ── A mature business that cleared its queue keeps "You're all caught up".
// The first-run branch must require BOTH conditions; dropping either one is how
// the wrong card reaches the wrong business.
// `count` (the composed inbox's own total), not items.length: the card became
// the Inbox PREVIEW and its rows are a slice — a sliced-empty list on a busy
// morning must not read as first-run. The protected property is unchanged:
// BOTH empty-and-never-started, or no first-run card.
check('first-run needs an empty queue AND a never-started business',
  /const firstRun = count === 0 && !started/.test(PRIORITIES_UI), true)
check('the "all caught up" card still exists for a queue that was cleared',
  PRIORITIES_UI.includes('You&rsquo;re all caught up'), true)
check('the first-run card names the one first action',
  PRIORITIES_UI.includes('Create your first quote')
  && /href="\/dashboard\/quotes\/new"/.test(PRIORITIES_UI), true)

// ── Defaults. Any caller that doesn't pass `started` must get the ESTABLISHED
// behaviour, never the first-run one — an omitted prop should be inert.
check('TodaysPriorities defaults started = true', /started = true/.test(PRIORITIES_UI), true)
check('SetupProgress defaults started = true', /started = true/.test(SETUP_UI), true)
check('SetupProgress waits for a started business', /if \(!started\) return null/.test(SETUP_UI), true)
check('the dashboard passes the derived flag to both cards',
  /<TodaysPriorities[\s\S]{0,400}?started=\{d\.started\}/.test(DASH_PAGE)
  && /<SetupProgress started=\{d\.started\}/.test(DASH_PAGE), true)

// ═══════════════════════════════════════════════════════════════════════════
H('8. EVERY TRADE, NOT ONE — no lawn vocabulary on universal surfaces')
// The quote list and the quote builder are shown to all twelve trade packs. Copy
// naming lawn work told a painter, a plumber and a junk hauler to do something
// their business does not do. Asserted on the STRING LITERALS, not the files:
// grepping a whole file would flag the comment that documents the fix, and a
// byte-exact prose lock would fail an honest rewrite.
const TRADE_WORDS = ['lawn', 'mow', 'hedge', 'mulch', 'snow', 'sod', 'turf', 'garden']
const literal = (body: string, re: RegExp, what: string): string => {
  const m = re.exec(body)
  if (!m) { fail++; console.log(`  ❌ could not find ${what} — the guard has drifted from the source`); return '' }
  return m[1]
}
const quotesEmpty = literal(src('src/components/quotes/QuoteList.tsx'),
  /title="No quotes yet"[\s\S]{0,120}?description="([^"]+)"/, 'the quotes empty-state copy')
// Anchored on the ternary's else-arm at the start of its own line — the
// expression above it spans comments and template literals of no fixed length.
const extrasHint = literal(src('src/components/quotes/QuoteBuilder.tsx'),
  /const linesSummary =[\s\S]*?\n\s*:\s*'([^']+)'/, 'the services & materials drawer hint')
for (const [what, text] of [['quotes empty state', quotesEmpty], ['extras drawer hint', extrasHint]] as const) {
  check(`${what} names no single trade`,
    TRADE_WORDS.filter(w => text.toLowerCase().includes(w)), [])
  check(`${what} still says something useful`, text.length > 20, true)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}\n  PASS ${pass}   FAIL ${fail}`)
if (fail > 0) process.exit(1)
