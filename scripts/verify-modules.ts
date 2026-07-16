// ── Verify: the feature-module engine (registry + composition + marketplace) ──
//   npm run verify:modules
//
// WHY THIS SCRIPT EXISTS
// The module system decides what every business SEES. A broken dependency
// closure silently hides a module someone paid attention to; a bad normalize
// freezes a business out of future modules; a wrong uninstall guard strands a
// dependent module without its foundation. None of that is a type error — tsc
// and next build pass with all of it broken. This exercises the REAL engine
// (no copies, no mocks): registry integrity, composition semantics, dependency
// math, the install/uninstall rules, the update system, and the licensing
// hook. Deterministic, no network — runs in CI beside the other verifiers.

import {
  FEATURE_MODULES, MODULE_CATEGORIES, visibleModules, installedKeys,
  normalizeEnabled, dependencyClosure, installSet, uninstallSet,
  uninstallBlockers, pendingUpdate, stampMeta, readMeta, isEntitled, moduleByKey,
} from '../src/lib/modules'

let failures = 0
const ok = (name: string) => console.log(`  ✓ ${name}`)
const fail = (name: string, detail: string) => { failures++; console.log(`  ✗ ${name}\n      ${detail}`) }
const check = (name: string, cond: boolean, detail = '') => (cond ? ok(name) : fail(name, detail))

const NON_CORE = FEATURE_MODULES.filter(m => !m.core).map(m => m.key)
const ALL_KEYS = FEATURE_MODULES.map(m => m.key)

// ── 1. Registry integrity — the marketplace contract ─────────────────────────
console.log('\nRegistry integrity:')
{
  check('module keys are unique', new Set(ALL_KEYS).size === ALL_KEYS.length)
  check('module hrefs are unique', new Set(FEATURE_MODULES.map(m => m.href)).size === FEATURE_MODULES.length)
  check('every module has a category from the catalogue',
    FEATURE_MODULES.every(m => m.category in MODULE_CATEGORIES))
  check('every module has a version ≥ 1', FEATURE_MODULES.every(m => Number.isInteger(m.version) && m.version >= 1))
  check('every module declares a permission manifest', FEATURE_MODULES.every(m => m.permissions.length > 0))
  check('every declared dependency exists in the registry',
    FEATURE_MODULES.every(m => (m.requires ?? []).every(k => ALL_KEYS.includes(k))),
    'a requires[] key does not match any module')
  check('no core module depends on anything', FEATURE_MODULES.every(m => !m.core || !(m.requires?.length)))
  check('no module depends on itself (directly or transitively)',
    FEATURE_MODULES.every(m => !dependencyClosure(m.key).includes(m.key)))
  // Cycle safety: dependencyClosure guards with a seen-set; a cycle would show
  // up as a module appearing in its own closure (previous check) or a hang.
  check('dependency closures terminate for every module',
    FEATURE_MODULES.every(m => Array.isArray(dependencyClosure(m.key))))
}

// ── 2. Composition semantics — what a business sees ──────────────────────────
console.log('\nComposition (visibleModules / installedKeys / normalizeEnabled):')
{
  check('NULL column → every module visible', visibleModules(null).length === FEATURE_MODULES.length)
  check('garbage column → every module visible (fail-open, never hide by accident)',
    visibleModules('oops').length === FEATURE_MODULES.length && visibleModules(42).length === FEATURE_MODULES.length)
  check('empty list → core modules only',
    visibleModules([]).every(m => m.core) && visibleModules([]).length === FEATURE_MODULES.filter(m => m.core).length)
  check('unknown keys in the column are tolerated',
    visibleModules(['schedule', 'not-a-module']).some(m => m.key === 'schedule'))
  check('core modules are visible even when omitted from the list',
    visibleModules(['schedule']).some(m => m.core))
  check('installedKeys(null) = all non-core', installedKeys(null).length === NON_CORE.length)
  check('installedKeys filters unknown + core keys',
    installedKeys(['schedule', 'dashboard', 'bogus']).join(',') === 'schedule')
  check('normalizeEnabled(full set) → NULL (future modules stay auto-installed)',
    normalizeEnabled([...NON_CORE]) === null)
  check('normalizeEnabled(partial) → stable registry-ordered list',
    JSON.stringify(normalizeEnabled(['grow', 'schedule'])) === JSON.stringify(NON_CORE.filter(k => k === 'schedule' || k === 'grow')))
}

// ── 3. Dependencies — install pulls, uninstall guards ─────────────────────────
console.log('\nDependencies (payments → invoices → customers):')
{
  const payments = moduleByKey('payments')
  check('payments requires invoices (fixture sanity)', !!payments?.requires?.includes('invoices'))
  const closure = dependencyClosure('payments')
  check('closure is transitive: payments pulls invoices AND customers',
    closure.includes('invoices') && closure.includes('customers'), `closure=${closure.join(',')}`)
  const fresh = installSet([], 'payments')
  check('installing payments installs its whole closure',
    fresh.includes('payments') && fresh.includes('invoices') && fresh.includes('customers'))
  check('install is idempotent', JSON.stringify(installSet(fresh, 'payments')) === JSON.stringify(fresh))
  const blockers = uninstallBlockers(fresh, 'invoices')
  check('uninstalling invoices is BLOCKED while payments is installed',
    blockers.some(b => b.key === 'payments'), `blockers=${blockers.map(b => b.key).join(',')}`)
  const withoutPayments = uninstallSet(fresh, 'payments')
  check('after removing payments, invoices is free to go',
    uninstallBlockers(withoutPayments, 'invoices').length === 0)
  check('uninstall never removes more than asked',
    withoutPayments.includes('invoices') && withoutPayments.includes('customers') && !withoutPayments.includes('payments'))
  check('a full install (NULL semantics) blocks removing a depended-on module',
    uninstallBlockers(installedKeys(null), 'customers').length > 0)
}

// ── 4. Update system ──────────────────────────────────────────────────────────
console.log('\nUpdate system (module_meta):')
{
  const grow = moduleByKey('grow')!
  check('no meta → treated as current (never nag pre-update-system businesses)',
    !pendingUpdate(grow, readMeta(null)) && !pendingUpdate(grow, {}))
  check('older installed version → pending update',
    pendingUpdate(grow, { grow: { v: grow.version - 1 } }) === true)
  check('current version → no pending update',
    pendingUpdate(grow, { grow: { v: grow.version } }) === false)
  const stamped = stampMeta({}, ['grow'], '2026-07-15T00:00:00Z')
  check('stampMeta records the registry version + timestamp',
    stamped.grow?.v === grow.version && stamped.grow?.at === '2026-07-15T00:00:00Z')
  check('stampMeta ignores unknown keys and preserves existing entries',
    JSON.stringify(stampMeta({ schedule: { v: 1 } }, ['bogus']).schedule) === JSON.stringify({ v: 1 }))
  check('readMeta rejects non-object garbage', Object.keys(readMeta([1, 2])).length === 0 && Object.keys(readMeta('x')).length === 0)
}

// ── 5. Licensing hook ─────────────────────────────────────────────────────────
console.log('\nLicensing hook:')
{
  check('every current module is free (no sku) and entitled',
    FEATURE_MODULES.every(m => !m.sku && isEntitled(m)))
  const paid = { ...moduleByKey('grow')!, sku: 'grow-pro' }
  check('a sku\'d module routes through the hook without throwing',
    typeof isEntitled(paid, { licenses: [] }) === 'boolean')
}

console.log('')
if (failures) { console.log(`✗ ${failures} check(s) failed\n`); process.exit(1) }
console.log('✓ all module-engine checks passed — registry, composition, dependencies, updates, licensing\n')
