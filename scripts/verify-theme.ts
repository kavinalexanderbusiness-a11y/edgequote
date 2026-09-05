// Actual theme helpers with a synthetic document/storage/OS preference. No browser
// profile, production data, network, or user preference is read or changed.
import assert from 'node:assert/strict'
import { applyThemePref, getThemePref, resolveTheme, THEME_KEY, type ThemePref } from '../src/lib/theme'

const globals = globalThis as unknown as Record<string, unknown>
const previousWindow = globals.window, previousDocument = globals.document
let passes = 0
const check = (label: string, run: () => void) => { run(); passes++; console.log(`  PASS ${label}`) }

function fixture(stored: string | null, options: { readDenied?: boolean; writeDenied?: boolean; light?: boolean; active?: ThemePref } = {}) {
  const dataset: Record<string, string> = options.active ? { themePref: options.active, theme: options.active === 'system' ? 'dark' : options.active } : {}
  let systemLight = !!options.light
  const writes: { key: string; value: string; alreadyApplied: boolean }[] = []
  globals.document = { documentElement: { dataset } }
  globals.window = {
    localStorage: {
      getItem(key: string) { assert.equal(key, THEME_KEY); if (options.readDenied) throw new Error('Synthetic storage denial'); return stored },
      setItem(key: string, value: string) {
        // The chosen appearance must already be visible when persistence begins.
        writes.push({ key, value, alreadyApplied: dataset.themePref === value && dataset.theme === resolveTheme(value as ThemePref) })
        if (options.writeDenied) throw new Error('Synthetic storage quota exceeded')
        stored = value
      },
    },
    matchMedia: (query: string) => { assert.equal(query, '(prefers-color-scheme: light)'); return { matches: systemLight } },
  }
  return { dataset, writes, stored: () => stored, setSystemLight: (value: boolean) => { systemLight = value } }
}

try {
  delete globals.window; delete globals.document
  check('server rendering defaults safely without browser globals', () => {
    assert.equal(getThemePref(), 'dark'); assert.equal(resolveTheme('system'), 'dark'); applyThemePref('light')
  })
  for (const stored of [null, 'invalid']) {
    fixture(stored)
    check(`${stored === null ? 'missing' : 'invalid'} stored preference defaults to dark`, () => assert.equal(getThemePref(), 'dark'))
  }
  for (const pref of ['light', 'dark', 'system'] as const) {
    const f = fixture(pref, { light: true })
    check(`normal ${pref} preference reads, applies and persists`, () => {
      assert.equal(getThemePref(), pref); applyThemePref(pref)
      assert.equal(f.stored(), pref); assert.equal(f.dataset.themePref, pref)
      assert.equal(f.dataset.theme, pref === 'system' ? 'light' : pref)
      assert.deepEqual(f.writes, [{ key: THEME_KEY, value: pref, alreadyApplied: true }])
    })
  }
  fixture(null, { readDenied: true })
  check('blocked storage reads return the dark default without throwing', () => assert.equal(getThemePref(), 'dark'))
  fixture(null, { readDenied: true, active: 'light' })
  check('blocked storage preserves an already active preference', () => assert.equal(getThemePref(), 'light'))

  const dark = fixture('light', { writeDenied: true, active: 'light' })
  check('Dark applies before a denied write and stays selected over stale stored Light', () => {
    applyThemePref('dark')
    assert.equal(dark.dataset.theme, 'dark'); assert.equal(dark.dataset.themePref, 'dark')
    assert.equal(dark.stored(), 'light'); assert.equal(getThemePref(), 'dark')
    assert.deepEqual(dark.writes, [{ key: THEME_KEY, value: 'dark', alreadyApplied: true }])
  })
  const system = fixture('light', { writeDenied: true, active: 'dark', light: true })
  check('System selection survives failed persistence and follows later OS changes', () => {
    applyThemePref('system'); assert.equal(system.dataset.theme, 'light'); assert.equal(getThemePref(), 'system')
    system.setSystemLight(false)
    if (getThemePref() === 'system') applyThemePref('system')
    assert.equal(system.dataset.theme, 'dark'); assert.equal(getThemePref(), 'system')
  })
  const explicit = fixture('system', { light: true, active: 'dark' })
  check('an explicit Dark selection does not follow the OS or a stale stored System preference', () => {
    if (getThemePref() === 'system') applyThemePref('system')
    assert.equal(explicit.dataset.theme, 'dark'); assert.equal(getThemePref(), 'dark')
  })
  console.log(`\nverify:theme — ${passes} passed, 0 failed\n`)
} finally {
  if (previousWindow === undefined) delete globals.window; else globals.window = previousWindow
  if (previousDocument === undefined) delete globals.document; else globals.document = previousDocument
}
