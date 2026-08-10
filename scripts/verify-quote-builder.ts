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
check('Duration is one of the things hidden',
  /<details className="group\/line">[\s\S]{0,900}?Duration \(min\)/.test(CODE),
  'it affects scheduling, not the price — it should not sit in the money row')
check('the discount + notes row is hidden too',
  (CODE.match(/<details className="group\/line">[\s\S]{0,1200}?lineDiscountRow\(i\)/g) || []).length === 2)
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

console.log('\n── Summary ────────────────────────────────────────────────────')
if (failures) {
  console.log(`\n❌ verify:quote-builder — ${failures} failure${failures === 1 ? '' : 's'}\n`)
  process.exit(1)
}
console.log('\n✅ verify:quote-builder — three drawers, four-control lines, every audit marker intact\n')
