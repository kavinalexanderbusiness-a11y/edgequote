// ── Verify: Settings never claims a save it can't prove ──────────────────────
//   npm run verify:settings-save
//
// WHY THIS SCRIPT EXISTS
// Settings runs TWO interaction patterns on purpose — three form tabs behind one
// explicit footer, everything else instant-with-rollback or own-Save — and both
// have failure modes tsc can't see:
//
//   · `.update()` on business_settings: nothing else ever creates that row, so
//     on an account without one the update matches ZERO rows, reports NO error,
//     and the UI caches a value the database never stored ("Saved", forever
//     wrong on every other device). The back-office audit named this the
//     settings-lane rule: upsert on user_id, always.
//   · useBusinessData ALWAYS background-revalidates seconds after mount — an
//     unguarded re-seed effect overwrites whatever the owner started editing.
//   · Half the savable state (work days, start time, capacity, seasons, tiers)
//     lives OUTSIDE react-hook-form, so `isDirty` alone lets the footer say
//     "no changes" over real unsaved edits.
//
// Every check below is a contract that shipped broken at least once.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const PAGE = read('src/app/dashboard/settings/page.tsx')

// ── 1. The settings-lane rule: business_settings is upsert-only ──────────────
console.log('\n═══ A write that can match zero rows is not a save ═══')
const LANE = [
  'src/app/dashboard/settings/page.tsx',
  'src/app/dashboard/settings/templates/page.tsx',
  'src/components/settings/AutomationToggles.tsx',
  'src/components/settings/MessageTemplateEditor.tsx',
  'src/components/settings/PayrollSettings.tsx',
  'src/components/settings/PushNotificationSettings.tsx',
  'src/components/settings/WebsiteIntegration.tsx',
  'src/components/settings/ModuleManager.tsx',
  'src/components/settings/CommunicationsTest.tsx',
  'src/components/settings/MessagingUsage.tsx',
]
for (const f of LANE) {
  const src = read(f)
  // Match a business_settings write chain that uses .update( — with or without
  // intervening whitespace/newlines between from() and the verb.
  const bare = /from\('business_settings'\)\s*\n?\s*\.update\(/.test(src)
  check(`${f.split('/').pop()} never bare-updates business_settings`, !bare,
    'on a missing row .update() matches zero rows with NO error — upsert on user_id instead')
}
check('the page upserts business_settings with onConflict user_id',
  (PAGE.match(/from\('business_settings'\)\s*\n?\s*\.upsert\(/g) || []).length >= 3)

// ── 2. The revalidate can no longer clobber an edit in progress ──────────────
console.log('\n═══ The owner’s screen wins while anything is unsaved ═══')
check('the re-seed effect bails while dirty',
  /if \(dirtyRef\.current\) return\s*\n\s*reset\(/.test(PAGE),
  'useBusinessData revalidates seconds after mount — an unguarded reset() eats live edits')
check('dirtyRef mirrors the ONE combined dirty answer',
  /const dirty = isDirty \|\| metaDirty/.test(PAGE) && /dirtyRef\.current = dirty/.test(PAGE))

// ── 3. Out-of-form edits count as unsaved ────────────────────────────────────
console.log('\n═══ Every editor marks the footer dirty ═══')
for (const [what, re] of [
  ['work days', /const toggleDay = \(i: number\) => \{ setMetaDirty\(true\)/],
  ['work start time', /const editWorkStart = [\s\S]{0,60}setMetaDirty\(true\)/],
  ['daily capacity', /const editCapacityHours = [\s\S]{0,60}setMetaDirty\(true\)/],
  ['seasons', /touchSeasons = [\s\S]{0,160}setMetaDirty\(true\)/],
  ['travel-fee tiers', /function updateTier\([\s\S]{0,120}setMetaDirty\(true\)/],
] as const) {
  check(`${what} light the footer`, re.test(PAGE),
    'an out-of-form edit the footer can’t see is an edit the owner loses')
}
check('the JSX actually uses the dirty-marking setters',
  /onChange=\{e => editWorkStart\(/.test(PAGE) && /onChange=\{e => editCapacityHours\(/.test(PAGE))

// ── 4. The footer tells the truth in all three states ───────────────────────
console.log('\n═══ The Save footer: unsaved / saving / saved, unmistakably ═══')
check('Save is disabled when there is nothing to save', /disabled=\{!dirty\}/.test(PAGE),
  'an enabled button over no changes claims work it cannot do')
check('unsaved state is loud and specific',
  /Unsaved changes — nothing here saves until you press Save\./.test(PAGE))
check('the clean state states the whole contract',
  /This one button saves everything on the Business, Pricing & Scheduling tabs\./.test(PAGE))
check('a failed tier save keeps the footer dirty', (() => {
  const at = PAGE.indexOf('tierResults.some(r => r.error)')
  const clear = PAGE.indexOf('setMetaDirty(false)')
  return at > 0 && clear > at   // the clear only happens past the failure return
})(), 'clearing dirty before the tier check would show a green footer over an unsaved tier')
check('success makes the form pristine IMMEDIATELY (reset(values))',
  /reset\(values\)\s*\n\s*setMetaDirty\(false\)/.test(PAGE),
  'without it the footer shows an amber edge around a button that just said Saved')
check('refresh/close with unsaved edits warns (beforeunload)',
  /beforeunload/.test(PAGE) && /if \(!dirty\) return/.test(PAGE))
check('the save claims nothing before the error is checked',
  PAGE.indexOf("toast.error('Could not save settings") < PAGE.indexOf('setSaved(true)'))

// ── 5. The two patterns are STATED, and edits survive tab switches ───────────
console.log('\n═══ The contract is written where the owner is standing ═══')
// The census is DERIVED from the tab registry rather than hand-kept as a number.
// A hardcoded count says "6" until somebody adds a tab, and then it fails for the
// arithmetic rather than for the contract — which teaches the next reader to bump
// the number instead of asking whether the new tab makes its promise.
// ⚠️ A tab key may contain a hyphen ('custom-fields'), so these patterns are
// [\w-]+ and not \w+ — the narrower class silently skipped such a tab entirely.
const TAB_KEYS = [...PAGE.matchAll(/\{ key: '([\w-]+)', label:/g)].map(m => m[1])
// The three that share ONE Save footer at the bottom of the page; every other tab
// owns its own saving behaviour and therefore owes the owner a sentence about it.
const FORM_TABS = ['business', 'pricing', 'scheduling']
const selfSavingTabs = TAB_KEYS.filter(k => !FORM_TABS.includes(k))
// ⚠️ Bounded by the NEXT tab's marker, not by a fixed character count. A fixed
// window spills into the following block, so a tab that had lost its own
// SaveContract still "found" its neighbour's and the check passed — verified by
// deleting one and watching this stay green until the bound was fixed.
const tabBlock = (key: string) => {
  const start = PAGE.indexOf(`tab !== '${key}' && 'hidden'`)
  if (start === -1) return ''
  const next = PAGE.slice(start + 1).search(/tab !== '[\w-]+' && 'hidden'/)
  return next === -1 ? PAGE.slice(start) : PAGE.slice(start, start + 1 + next)
}
const withoutContract = selfSavingTabs.filter(k => !/<SaveContract text=/.test(tabBlock(k)))
check(`every non-form tab carries a SaveContract line — ${selfSavingTabs.length} checked`,
  TAB_KEYS.length > 0 && withoutContract.length === 0,
  withoutContract.length
    ? `${withoutContract.join(', ')} — a tab that saves on its own must say so`
    : 'no tab keys parsed out of SETTINGS_TABS')
check('instant tabs say instant; payroll says press Save',
  /save the moment you make them/.test(PAGE) && /Nothing on this tab saves until you press its Save button/.test(PAGE))
check('inactive tabs hide, never unmount (edits survive switching)',
  (PAGE.match(/tab !== '[\w-]+' && 'hidden'/g) || []).length >= TAB_KEYS.length - FORM_TABS.length + 2,
  'conditional unmount would throw away half-typed edits on every tab switch')

// ── 6. The instant/own-Save components keep their proven shapes ──────────────
console.log('\n═══ The component tabs stay honest ═══')
const AT = read('src/components/settings/AutomationToggles.tsx')
check('automation toggles roll back on a failed write', /switched back|put back/.test(AT))
const MTE = read('src/components/settings/MessageTemplateEditor.tsx')
check('templates only flash Saved after the write is checked',
  MTE.indexOf('toast.error') < MTE.indexOf('setSaved(true)'))
const PS = read('src/components/settings/PayrollSettings.tsx')
check('payroll only flashes Saved after the write is checked',
  PS.indexOf('toast.error') < PS.indexOf('setSaved(true)'))
const WI = read('src/components/settings/WebsiteIntegration.tsx')
check('the booking toggle and the rate limit both revert on failure',
  /setEnabled\(!v\)/.test(WI) && /setHourlyLimit\(prev\)/.test(WI))

// ── 7. Mobile: the footer stays reachable ────────────────────────────────────
console.log('\n═══ The footer wins the phone’s stacking contest ═══')
check('the footer is sticky at the true bottom with the nav-clearing z-index',
  /order-4 sticky bottom-0 z-20/.test(PAGE),
  'z-10 rendered the Save bar UNDER the fixed z-40 BottomNav for the length of the form')

console.log(failures === 0
  ? '\n✅ settings-save: the owner always knows what saved, what didn’t, and what’s waiting.\n'
  : `\n❌ settings-save: ${failures} contract${failures === 1 ? '' : 's'} broken.\n`)
process.exit(failures === 0 ? 0 : 1)
