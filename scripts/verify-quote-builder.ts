// ── Verify: the quote builder's fast path, and the contracts under it ────────
//   npm run verify:quote-builder
//
// WHY THIS SCRIPT EXISTS
// The owner said building a quote still felt like paperwork, and a real-browser
// measurement agreed: at 390px a blank quote ran 2.08 screens, a two-line quote
// 3.32, and SEVEN shut drawers sat under every one of them. Adding a second item
// cost NINE controls (Service, From template, Qty, Unit, Unit price, Duration,
// Discount, Value, Notes) — and that form existed TWICE, in an "Additional
// services" drawer and a "Materials" drawer, for lines the model already keeps in
// ONE array discriminated by `kind`. The builder's own comment said so:
// "this is a view, not a second system".
//
// So this guard has two halves:
//   1. the FAST PATH — three drawers, not seven; a line shows the four controls
//      that decide money and hides the rest;
//   2. the CONTRACTS — nine prior audit rounds fixed data-loss bugs in this file,
//      each leaving a marker. A presentation change must not cost any of them.
//      §Markers below is that list, and it is the reason this restructure could
//      be attempted at all.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildServiceMenu, serviceMatches, RECENT_MAX } from '../src/lib/servicePicker'
import { recentTemplateIdsFrom } from '../src/lib/quoteServices'
import type { ServiceTemplate } from '../src/types'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const QB = read('src/components/quotes/QuoteBuilder.tsx')
const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const CODE = stripComments(QB)

// ── 1. Three drawers, not seven ──────────────────────────────────────────────
console.log('\n═══ The fast path is not a wall of drawers ═══')

const drawers = [...CODE.matchAll(/<Collapsible\s+title="([^"]+)"/g)].map(m => m[1])
check('exactly three top-level drawers', drawers.length === 3,
  `found ${drawers.length}: ${drawers.join(' · ')} — seven shut doors read as seven unanswered questions`)
for (const t of ['Pricing help', 'Services & materials', 'More options']) {
  check(`"${t}" is one of them`, drawers.includes(t), `drawers are: ${drawers.join(' · ')}`)
}
// The seven it replaced must not creep back as peers.
for (const gone of ['Labour calculator', 'Plan pricing', 'Travel', 'Additional services', 'Materials', 'Notes', 'Scheduling']) {
  check(`"${gone}" is no longer its own drawer`, !drawers.includes(gone),
    'it belongs inside one of the three — as a labelled block, not a nested collapsible')
}
// An earlier audit flattened "Advanced Pricing" precisely because collapsibles
// inside a collapsible read as depth the owner has to navigate. Same rule here.
check('no Collapsible is nested inside another',
  !/<Collapsible[\s\S]*?<Collapsible[\s\S]*?<\/Collapsible>[\s\S]*?<\/Collapsible>/.test(
    CODE.replace(/<Collapsible[\s\S]*?<\/Collapsible>/g, m => m.includes('<Collapsible', 12) ? m : '')),
  'grouping is done with labelled blocks, not another layer of doors')

// ── 2. A drawer has to say what is inside it ─────────────────────────────────
for (const s of ['pricingHelpSummary', 'linesSummary', 'moreSummary']) {
  check(`${s} exists`, CODE.includes(`const ${s}`),
    'a closed drawer with no summary is just a door')
}

// ── 3. Adding a line is four controls, not nine ──────────────────────────────
console.log('\n═══ A second line is not a second form ═══')

check('the per-line extras sit behind a disclosure',
  (CODE.match(/<details className="group\/line">/g) || []).length === 2,
  'both the service line and the material line need one')
// ⚠️ These two used to be character-window regexes anchored on the literal copy
// "Duration (min)". Both broke when Session 54 swapped that box for the shared
// Minutes/Hours/Workdays control — a correct change, reported as a defect,
// because the assertion was about the WORDING and the window LENGTH rather than
// about containment. Same trap as the SMS prose locks. The blocks are extracted
// properly now, so what is asserted is what was always meant: these controls are
// INSIDE the disclosure, however long it grows and whatever the field is called.
const detailBlocks = (() => {
  const out: string[] = []
  const open = '<details className="group/line">'
  for (let i = CODE.indexOf(open); i !== -1; i = CODE.indexOf(open, i + 1)) {
    const end = CODE.indexOf('</details>', i)
    if (end !== -1) out.push(CODE.slice(i, end))
  }
  return out
})()
check('Duration is one of the things hidden',
  detailBlocks.some(b => /<DurationField|Duration \(min\)/.test(b)),
  'it affects scheduling, not the price — it should not sit in the money row')
check('the discount + notes row is hidden too',
  detailBlocks.filter(b => b.includes('lineDiscountRow(i)')).length === 2)
check('quantity, unit and unit price stay visible',
  /grid grid-cols-3 gap-3">[\s\S]{0,700}?qtyLabelFor[\s\S]{0,700}?unit_price/.test(CODE),
  'these three decide the money and must never move behind a disclosure')
// The disclosure must not be React state: `watch()` subscribes every field for
// autosave, so a state toggle here re-renders the whole form on a phone.
check('the disclosure is native, not React state',
  !/useState[^\n]*lineOpen|openLines/.test(CODE),
  'native <details> keeps one line`s toggle from re-rendering the entire builder')

// ── 4. Services and materials are ONE list ───────────────────────────────────
console.log('\n═══ Two drawers for one array is the model leaking ═══')
check('materials render inside the services drawer',
  CODE.indexOf('materialIdx.map') > CODE.indexOf('serviceIdx.map')
  && CODE.indexOf('materialIdx.map') < CODE.lastIndexOf('</Collapsible>'),
  'they are the same `services` array split by `kind` — the file says so itself')
check('the cross-drawer pointer is gone',
  !CODE.includes('Materials are listed separately below'),
  'nothing is "below" any more; they are in one place')
check('kind is still submitted per line',
  // Anchored past the identifier: /\.kind/ alone also matches `.kindX`, so a
  // renamed field sailed through this check until the mutation test caught it.
  (CODE.match(/services\.\$\{i\}\.kind` as const/g) || []).length >= 1,
  'the discriminator is form state — dropping it would refile every material as a service')

// ── 5. Opening the right drawer on a blocked save still works ────────────────
// `crew_size` is required and lives in Pricing help. Save used to fail SILENTLY
// because react-hook-form focused a field that was not mounted. The invalid
// handler opens the section holding the error — and it still writes the OLD
// per-section flags, so the new shells must be driven BY those flags.
console.log('\n═══ A blocked save still opens the section holding the error ═══')
check('Pricing help is driven by laborOpen || planOpen',
  /open=\{laborOpen \|\| planOpen\}/.test(CODE))
check('Services & materials is driven by servicesOpen || materialsOpen',
  /open=\{servicesOpen \|\| materialsOpen\}/.test(CODE))
for (const setter of ['setLaborOpen(true)', 'setPlanOpen(true)', 'setTravelOpen(true)', 'setMaterialsOpen(true)', 'setServicesOpen(true)']) {
  check(`the invalid handler still calls ${setter}`, CODE.includes(setter),
    'these are what make "we’ve opened the section holding them" true')
}
check('crew_size is still required', /register\('crew_size', \{ required: 'Required'/.test(CODE))

// ── 6. §Markers — the nine audit rounds under this file ──────────────────────
// Every entry is a bug that was found in production and fixed. A rebase or a
// restructure that loses one loses the fix silently: the titles survive, the
// behaviour does not. (That exact failure has happened twice in this file.)
console.log('\n═══ Nine rounds of fixes are still here ═══')
const MARKERS: [string, string][] = [
  ['const BLANK', 'blank numeric seeds — a 0 seed painted eight zeros onto a fresh form'],
  ['autoFilledAddress', 'picking a customer must not destroy a typed job-site address'],
  ['autoFilledNotes', 'changing service must not destroy typed notes'],
  ['autoFilledSqft', 'customer A’s lawn size must not price customer B'],
  ['markApplied', '“✓ Applied” must not survive a service change'],
  ['zeroTotalArmed', 'a $0 quote warns before it saves'],
  ['halfSpecified', 'a discount with no type silently applied nothing'],
  ['lineEquation', 'the hourly “Qty 1 × $95 for a 3-hour job” underpricing trap'],
  ['lineTemplateOptions', 'retired templates with stale rates were one tap from the total'],
  ['setFocus', 'focus lands in the new line, not the button below it'],
  ['tap-target-y', 'remove-line was a 16px target on a control that deletes a priced line'],
  ['showCustomerPicker', 'Enter in the picker used to fall through and save a half-built quote'],
  ['onManual', 'the typed name carries into “add as new customer”'],
  ['onCancel', 'Cancel on edit returns to the quote, not out of the app'],
  ['serviceLineTotals', 'THE one line-total engine'],
]
for (const [m, why] of MARKERS) {
  check(`${m} — ${why.slice(0, 52)}…`, QB.includes(m), `${why}. Restore it before shipping.`)
}

// ⭐ The TDZ crash: `kindAt` calls `watchedServices` synchronously, so the const
// must be declared ABOVE it. Below it, ONE line item blanks the whole builder
// with a ReferenceError — a live P0 that shipped for nine days.
// Both anchored past the identifier: 'const watchedServices' alone still matched
// after a rename to watchedServicesRENAMED, so the order check silently held on a
// declaration that no longer existed. (Found by mutating it.)
const iWatched = QB.indexOf('const watchedServices =')
const iKind = QB.indexOf('const kindAt =')
check('watchedServices is declared above kindAt', iWatched > 0 && iKind > 0 && iWatched < iKind,
  'a forward const inside a callback is invisible to tsc AND lint, and blanks the builder on any multi-line quote')

// ── 7. Money and send guardrails are untouched by a presentation pass ────────
console.log('\n═══ The money path is unchanged ═══')
for (const [needle, why] of [
  ['gst_percent', 'the builder preview discloses GST'],
  ['applyDiscount', 'canonical discount behaviour'],
  ['show_travel_separately', 'travel breakout honoured end to end'],
] as const) {
  check(`${needle} — ${why}`, QB.includes(needle))
}
// Sending is NOT the builder's job — it lives on the quote page, behind the same
// engine the PDF action uses. This pass reorganised composition and must not have
// reached across into it.
const QUOTE_PAGE = read('src/app/dashboard/quotes/[id]/page.tsx')
check('sendBlockedReason still gates the Send card', QUOTE_PAGE.includes('sendBlock'),
  'a $0 quote must stay undeliverable — the builder never sends, and still does not')
check('the builder still saves through onSubmit only',
  (QB.match(/await onSubmit\(/g) || []).length === 1,
  'one save door; the send/approval path lives on the quote page and is not bypassed here')

// ── 8. The service picker BEHAVES, not just renders ──────────────────────────
// The catalogue control was a native <select> holding the owner's whole service
// list — 24 options for the live business, and the cost of that is invisible to
// any height measurement because a <select> shows one row until it is opened.
// It also forced a SECOND field ("Service Name *"), because a <select> cannot
// express custom work. Both are gone: one combobox that IS the service_type
// input. These are behaviour assertions against the real ranking function, not
// greps for copy — the words in this UI are allowed to change, the answers are not.
console.log('\n═══ The service picker answers correctly ═══')

const svc = (id: string, name: string, category: string, extra: Partial<ServiceTemplate> = {}): ServiceTemplate => ({
  id, name, category, user_id: 'u', created_at: '', updated_at: '',
  default_rate: 65, pricing_display_type: 'starting_from', default_description: null, notes: null,
  is_active: true, sort_order: 0, unit_cost: null, material_cost: null, is_favorite: false, ...extra,
} as ServiceTemplate)

// Shaped like the live catalogue: services across 5 categories, and deliberately
// ordered so a CONTAINS match ("Bi-Weekly Mowing") sits ahead of the STARTS-WITH
// match ("Weekly Mowing") in source order — otherwise the ranking assertion below
// passes on an unsorted list and pins nothing. (It did; the mutation test caught it.)
const CAT: ServiceTemplate[] = [
  svc('t0', 'Bi-Weekly Mowing', 'Lawn Care'),
  svc('t1', 'Lawn Mowing', 'Lawn Care'), svc('t2', 'Weekly Mowing', 'Lawn Care'),
  svc('t3', 'One-Time Mowing', 'Lawn Care'), svc('t4', 'String Trimming', 'Lawn Care'),
  svc('t5', 'Spring Cleanup', 'Property Maintenance'), svc('t6', 'Fall Cleanup', 'Property Maintenance'),
  svc('t7', 'Weed Removal', 'Property Maintenance'), svc('t8', 'Mulch Installation', 'Landscaping'),
  svc('t9', 'Gravel Installation', 'Landscaping'), svc('t10', 'Hedge Trimming', 'Tree & Shrub Care'),
]
const names = (m: ReturnType<typeof buildServiceMenu>) =>
  m.rows.filter(r => r.type === 'template').map(r => (r as { t: ServiceTemplate }).t.name)
const headers = (m: ReturnType<typeof buildServiceMenu>) =>
  m.rows.filter(r => r.type === 'header').map(r => (r as { label: string }).label)

// Typing is the whole point. If this stops narrowing, the owner is back to a list.
const mow = buildServiceMenu(CAT, { query: 'mow', filtering: true })
check('typing narrows the catalogue', names(mow).length === 4 && names(mow).every(n => n.toLowerCase().includes('mow')),
  `got ${names(mow).join(' · ')}`)
const weekly = names(buildServiceMenu(CAT, { query: 'weekly', filtering: true }))
check('a name that STARTS with the query ranks first', weekly[0] === 'Weekly Mowing',
  `"Bi-Weekly Mowing" is earlier in the catalogue and still only CONTAINS the query — got ${weekly.join(' · ')}`)
// A category is a word the owner chose, and it is what they reach for when the
// service name is the thing they can't remember.
check('searching by the owner’s own category works',
  names(buildServiceMenu(CAT, { query: 'landscap', filtering: true })).length === 2)
check('no match returns nothing rather than everything',
  names(buildServiceMenu(CAT, { query: 'furnace repair', filtering: true })).length === 0,
  'an empty result is what tells the owner this will save as a custom service')
check('serviceMatches is case-insensitive both ways',
  serviceMatches(svc('x', 'Snow Removal', 'Winter'), 'SNOW') && serviceMatches(svc('x', 'Snow Removal', 'Winter'), 'winter'))

// Recent — read back out of quotes.service_template_id. No tracking was added,
// so this must survive ids that no longer resolve.
const withRecent = buildServiceMenu(CAT, { recentIds: ['t10', 't5'] })
check('recent services lead the list', names(withRecent).slice(0, 2).join('|') === 'Hedge Trimming|Spring Cleanup')
check('the Recent block is labelled', headers(withRecent)[0] === 'Recent')
check('a recent service is not listed twice',
  names(withRecent).filter(n => n === 'Hedge Trimming').length === 1,
  'it leads the list AND sat in its category — the same service on screen twice')
// Count the rows FLAGGED recent, not their position: with the cap removed the
// whole catalogue becomes "recent", the rest of the list empties, and any
// position-based assertion still reads as correct. (It did.)
const allRecent = buildServiceMenu(CAT, { recentIds: CAT.map(t => t.id) })
check('recent is capped',
  allRecent.rows.filter(r => r.type === 'template' && r.recent).length === RECENT_MAX,
  `a second full catalogue above the catalogue — got ${allRecent.rows.filter(r => r.type === 'template' && r.recent).length}`)
check('an unresolvable recent id is dropped, not rendered blank',
  !headers(buildServiceMenu(CAT, { recentIds: ['deleted-service-id'] })).includes('Recent'),
  'history can name a service that was since deleted or retired')
check('recent steps aside while searching',
  !headers(buildServiceMenu(CAT, { query: 'mow', filtering: true, recentIds: ['t10'] })).includes('Recent'),
  'the search IS the ranking — a Recent block would only push the asked-for row down')

// Grouping rides on the owner's OWN data and nothing else.
check('a categorised catalogue is grouped', buildServiceMenu(CAT).grouped)
check('grouping uses the owner’s categories verbatim',
  headers(buildServiceMenu(CAT)).includes('Tree & Shrub Care'))
check('ONE blank category falls back to a flat list',
  !buildServiceMenu([...CAT.slice(0, 9), svc('t11', 'Odd Job', '  ')]).grouped,
  'the alternative is inventing an "Other" bucket — a category architecture this UI must not create')
check('a short catalogue is not grouped',
  !buildServiceMenu(CAT.slice(0, 4)).grouped,
  'four headers over four services is organisation nobody asked for')
check('every offered service is reachable',
  names(buildServiceMenu(CAT)).length === CAT.length,
  'grouping and Recent reorder the list; they must never drop a row from it')

// The list is RANKED here and CHOSEN by the caller — a retired service can only
// appear because the builder deliberately passed it (a saved line pointing at one).
check('the picker ranks, it does not select',
  buildServiceMenu([svc('r1', 'Snow Removal', 'Winter', { is_active: false })]).rows.length === 1,
  'active-only filtering is the callers’ job (activeTemplates / lineTemplateOptions) — one filter, not two')

console.log('\n═══ "Recent" is read from history, never recorded ═══')
check('recentTemplateIdsFrom de-duplicates, newest first',
  recentTemplateIdsFrom([{ service_template_id: 'a' }, { service_template_id: 'b' }, { service_template_id: 'a' }])
    .join(',') === 'a,b')
check('nulls are skipped', recentTemplateIdsFrom([{ service_template_id: null }, { service_template_id: 'a' }]).join(',') === 'a')
check('a failed read is an empty list, not a crash',
  recentTemplateIdsFrom(null).length === 0 && recentTemplateIdsFrom(undefined).length === 0,
  'this ranks a list — losing it costs a scroll, and must never cost the catalogue')

// ── 9. One control per question, and it can still say anything ───────────────
console.log('\n═══ One service control, and custom work still fits in it ═══')
// The lookahead is load-bearing: a plain `[\s\S]{0,1400}?` span reached PAST the
// picker into the no-catalogue <Input> fallback right below it, so deleting the
// registration from the picker itself still matched. (Found by mutating it.)
check('the picker IS the service_type input',
  /<ServicePicker\b(?:(?!<Input|<ServicePicker)[\s\S])*?\{\.\.\.register\('service_type', \{ required: 'Service is required' \}\)\}/.test(CODE),
  'if it stops being the registered field, custom work needs a second field again — and that second field is the confusion this removed')
check('service_template_id survives submit',
  /<input type="hidden" \{\.\.\.register\('service_template_id'\)\} \/>/.test(CODE),
  'an unregistered field is dropped at submit, and that id decides which engine may recommend')
check('the second name field is gone',
  !/label="Service Name \*"/.test(CODE),
  'two labels for one answer, the required one looking unanswered')
check('the native catalogue <select> is gone',
  !/<Select label="Service"/.test(CODE) && !/<Select label="From template"/.test(CODE),
  'a 24-option dropdown per line, on the control used on every quote')
check('a business with NO catalogue still gets a plain field',
  /activeTemplates\.length > 0 \?[\s\S]{0,2000}?<Input label="Service \*"/.test(CODE),
  'a picker with nothing to pick is a door onto a wall')
check('extra lines fall back to a plain field too',
  /lineTemplateOptions\(line\?\.service_template_id\)\.length > 0 \?[\s\S]{0,1600}?<Input label="Service \*"/.test(CODE))
// The <select> could always be put back to "Select a service…". Losing that
// would leave an adopted service swappable but never removable — and the id it
// leaves behind is what decides which pricing engine may recommend.
check('a catalogue service can still be detached',
  (CODE.match(/onDetach=\{/g) || []).length === 2,
  'both the primary service and an extra line need the way back out')
check('detaching drops the LINK, never the name',
  /onDetach=\{\(\) => setValue\('service_template_id', ''\)\}/.test(CODE),
  'service_type is required — clearing it would empty the field the owner just filled')

console.log('\n═══ The price field is the main event ═══')
check('the "no recommended price" panel is gone',
  !/No recommended price/.test(CODE),
  'a bordered panel shouting an absence, above the one field the owner came to fill')
check('its reason moved onto the price field itself',
  /hint=\{[\s\S]{0,1400}?: noRecReason\s*\n?\s*\}/.test(CODE),
  'noRecReason still speaks — next to the box it is about, and it still links the Settings page it names')
check('noRecReason still names a page and hands over the door',
  CODE.includes('settingsLink(') && QB.includes('href="/dashboard/settings"'))

console.log('\n═══ Recurring pricing is asked for, not presented ═══')
check('the cadence fields are revealed', /\{showPlanFields \?/.test(CODE),
  'three empty money fields about a schedule that will never exist, on every one-visit quote')
check('a price already on the quote opens them by itself',
  /const showPlanFields = offerRecurring \|\| weeklyPrice > 0 \|\| biweeklyPrice > 0 \|\| monthlyPrice > 0/.test(CODE),
  'the reveal must never be able to hide money — a saved recurring quote, a plan tile and a measured lawn all write these')
check('a validation error on a plan price opens them too',
  /errors\.weekly_price \|\| errors\.biweekly_price \|\| errors\.monthly_price/.test(CODE),
  'the documented silent-save bug: react-hook-form blocking a submit to focus a field that is not mounted')
for (const f of ['weekly_price', 'biweekly_price', 'monthly_price']) {
  check(`${f} is still registered with its manual-override hook`,
    new RegExp(`register\\('${f}', \\{ min: 0, onChange`).test(CODE),
    'typing a plan price is the same act of ownership as typing the first-visit price')
}
// The four cadence columns are the ONLY real customer choice this product has
// (see the quote-choice audit). A presentation pass must not have touched them.
check('all four cadence values still reach the breakdown',
  ['weeklyPrice', 'biweeklyPrice', 'monthlyPrice', 'initialPrice'].every(v => CODE.includes(v)))

console.log('\n═══ A phone still gets a page it can read ═══')
check('the form column can go narrower than its content',
  /className="lg:col-span-2 space-y-4 min-w-0"/.test(CODE),
  'a grid item defaults to min-width:auto, and a Collapsible summary counts UN-WRAPPED toward min-content — ' +
  'measured: one longer summary pushed this column to 423px inside a 390px viewport')

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:quote-builder — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:quote-builder — three drawers, four-control lines, every audit marker intact\n')
