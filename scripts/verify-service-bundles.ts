// ── Verify: a bundle seeds a quote and then has nothing to do with it ────────
//   npm run verify:service-bundles
//
// WHAT THE FEATURE IS
// An owner should not rebuild "Spring Cleanup" from scratch every March. A
// BUNDLE is a named, reusable set of service lines that SEEDS a quote's scope.
//
// THE THREE NOUNS THIS GUARD EXISTS TO KEEP APART. This repo's proven failure
// mode is one word meaning several things (it once had three different objects
// all called a "follow-up"), and "template" was already taken before this
// feature existed:
//   Service — `service_templates`. ONE catalogue row, owning ONE default rate.
//             The Settings page is literally titled "Service Templates".
//   Bundle  — `service_bundles`. A SET of lines. Seeds a quote. THIS.
//   Option  — `quote_options`. ALTERNATIVE whole-job prices the customer picks
//             one of. An option REPLACES the total; a bundle seeds the lines
//             that ADD UP to one. The database refuses a quote holding both.
//
// ⭐⭐ THE CONTRACT THIS GUARD IS REALLY FOR: **a bundle is a COPY, not a live
// link.** Once a quote has been built from a bundle, editing or deleting that
// bundle must not reach the quote — including one already sent or approved.
// That is guaranteed structurally rather than by discipline: NOTHING on a quote
// records which bundle it came from. Section 4 proves the absence, and sections
// 6–8 prove the behaviour against the live database.
//
// ⚠️ THE LIVE HALF WRITES. Sections 5–8 sign in as the owner, create ONE
// fixture bundle (ZZ-VERIFY-BUNDLE) and ONE fixture quote (ZZ-VERIFY-BUNDLE-Q),
// attack them, and delete both in a finally. A leftover from a killed run is
// swept at the start of the next one. Everything it touches it made; it never
// asserts on the state of the real book (a guard that asserts on transient
// production data is its own outage — see the portal-invoice incident).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  bundleLines, bundleScope, bundleSummary, bundleTotal, captureBundleItems,
  cleanBundleName, priceBasis, resolveUnitPrice, templateIndex,
  type BundleSourceLine,
} from '../src/lib/serviceBundles'
// The quote's OWN adder, imported rather than restated: if a bundle's preview
// ever stops agreeing with the quote it previews, section 2 stops being true.
import { sumServiceLines } from '../src/lib/quoteServices'
import type { ServiceBundleItem, ServiceTemplate } from '../src/types'

for (const line of existsSync('.env.local') ? readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, cond: boolean, d = '') => cond ? ok(n) : fail(n, d)
const eq = (n: string, a: unknown, b: unknown) =>
  check(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

// ── Fixtures ─────────────────────────────────────────────────────────────────
const T = (over: Partial<ServiceTemplate> & { id: string; default_rate: number }): ServiceTemplate => ({
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  name: 'Fixture service', category: 'General', pricing_display_type: 'starting_from',
  default_description: null, notes: null, is_active: true, sort_order: 0, user_id: 'u1',
  unit_cost: null, material_cost: null, is_favorite: false, ...over,
});
const I = (over: Partial<ServiceBundleItem> & { name: string }): ServiceBundleItem => ({
  id: 'i-' + over.name, created_at: '2026-01-01T00:00:00Z', user_id: 'u1', bundle_id: 'b1',
  service_template_id: null, quantity: 1, unit: 'each', unit_price: null, est_minutes: null,
  notes: null, kind: 'service', sort_order: 0, ...over,
});

const CATALOGUE = [
  T({ id: 't-bed', name: 'Landscape Bed Cleanup', default_rate: 60 }),
  T({ id: 't-mow', name: 'Lawn Mowing', default_rate: 40 }),
  T({ id: 't-edge', name: 'Lawn Edging', default_rate: 35 }),
]
const IDX = templateIndex(CATALOGUE)

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. Price resolution — the catalogue owns the rate ═══')

// The DEFAULT is to follow the catalogue. This is the whole reason a bundle
// links to a service instead of copying its number.
eq('a null price follows the catalogue', resolveUnitPrice(I({ name: 'x', service_template_id: 't-bed' }), IDX), 60)
eq('…and says so', priceBasis(I({ name: 'x', service_template_id: 't-bed' }), IDX), 'catalogue')

// Re-price the service in Settings → every future quote follows, with no bundle
// to go and re-edit. Proven by re-resolving against a changed catalogue.
const REPRICED = templateIndex([T({ id: 't-bed', name: 'Landscape Bed Cleanup', default_rate: 75 })])
eq('re-pricing the SERVICE moves the bundle line', resolveUnitPrice(I({ name: 'x', service_template_id: 't-bed' }), REPRICED), 75)

eq("the owner's own figure wins", resolveUnitPrice(I({ name: 'x', service_template_id: 't-bed', unit_price: 90 }), IDX), 90)
eq('…and says so', priceBasis(I({ name: 'x', service_template_id: 't-bed', unit_price: 90 }), IDX), 'bundle')

// A price nobody has stated is 0 AND is labelled — never a fabricated number.
eq('unknown price resolves to 0', resolveUnitPrice(I({ name: 'custom' }), IDX), 0)
eq('…and is called unpriced, not free', priceBasis(I({ name: 'custom' }), IDX), 'unpriced')

// A line pointing at a catalogue row that no longer exists must not invent a
// price. (The database nulls the link on delete; this is the app side of it.)
eq('a dead catalogue link resolves to 0', resolveUnitPrice(I({ name: 'x', service_template_id: 't-gone' }), IDX), 0)
eq('…and is unpriced, not zero-priced', priceBasis(I({ name: 'x', service_template_id: 't-gone' }), IDX), 'unpriced')

// ⭐ ZERO IS A PRICE AN OWNER CAN MEAN. `unit_price: 0` must resolve to 0 as the
// BUNDLE's own figure — a `?? catalogue` fallback would silently re-price every
// deliberately-free line at the catalogue rate.
eq('a deliberate £0 stays £0', resolveUnitPrice(I({ name: 'x', service_template_id: 't-bed', unit_price: 0 }), IDX), 0)
eq('…and is the bundle’s own figure', priceBasis(I({ name: 'x', service_template_id: 't-bed', unit_price: 0 }), IDX), 'bundle')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. The total is the QUOTE’s adder, never a second one ═══')

const SPRING = [
  I({ id: 'i1', name: 'Landscape Bed Cleanup', service_template_id: 't-bed', quantity: 2, sort_order: 0 }),
  I({ id: 'i2', name: 'Lawn Mowing', service_template_id: 't-mow', sort_order: 1 }),
  I({ id: 'i3', name: 'Mulch', unit_price: 55, quantity: 3, kind: 'material', sort_order: 2 }),
]
// 2×60 + 1×40 + 3×55 = 325
eq('bundle total', bundleTotal(SPRING, IDX), 325)
eq('…is exactly sumServiceLines over its lines', bundleTotal(SPRING, IDX), sumServiceLines(bundleLines(SPRING, IDX)).net)
eq('an empty bundle totals 0', bundleTotal([], IDX), 0)

// Order is the owner's, and it decides which line becomes the primary service.
eq('lines come back in sort order',
  bundleLines(SPRING, IDX).map(l => l.service_type),
  ['Landscape Bed Cleanup', 'Lawn Mowing', 'Mulch'])
eq('sort_order beats insertion order',
  bundleLines([I({ id: 'b', name: 'B', sort_order: 5 }), I({ id: 'a', name: 'A', sort_order: 1 })], IDX).map(l => l.service_type),
  ['A', 'B'])

// ⛔ A discount is a concession on ONE deal. Baking one into a reusable scope is
// how every future customer silently gets money off.
check('no bundle line ever carries a discount',
  bundleLines(SPRING, IDX).every(l => l.discount_type === '' && l.discount_value === 0))
check('the kind survives — a material stays a material',
  bundleLines(SPRING, IDX)[2].kind === 'material')

eq('the summary counts both kinds', bundleSummary(SPRING), '2 services · 1 material')
eq('an empty bundle says so', bundleSummary([]), 'No lines yet')

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. Applying — the builder’s own shape, and no invented numbers ═══')

const scope = bundleScope(SPRING, IDX)
eq('the FIRST line becomes the primary service', scope.primary?.service_type, 'Landscape Bed Cleanup')
eq('…priced qty × unit price', scope.primary?.price, 120)
eq('…and keeps its catalogue link', scope.primary?.service_template_id, 't-bed')
eq('the rest become additional lines', scope.extras.length, 2)
eq('primary + extras = the whole bundle',
  Number(scope.primary?.price) + sumServiceLines(scope.extras).net, bundleTotal(SPRING, IDX))

// ⭐ Unknown hours is NOT zero hours. The builder is explicit that an empty
// hours field is correct rather than a gap; writing 0 would fabricate labour.
eq('no estimate ⇒ hours untouched', scope.primary?.hours, null)
eq('an estimate ⇒ hours in hours',
  bundleScope([I({ name: 'x', est_minutes: 90 })], IDX).primary?.hours, 1.5)
eq('an empty bundle applies nothing', bundleScope([], IDX), { primary: null, extras: [] })

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. Capture — the lines, and NOTHING about the customer ═══')

const QUOTE_LINES: BundleSourceLine[] = [
  { service_type: 'Landscape Bed Cleanup', service_template_id: 't-bed', quantity: 2, unit: 'each', unit_price: 60, est_minutes: 90, notes: null, kind: 'service' },
  { service_type: 'Lawn Mowing', service_template_id: 't-mow', quantity: 1, unit: 'each', unit_price: 55, est_minutes: null, notes: null, kind: 'service' },
  { service_type: 'Gate repair', service_template_id: null, quantity: 1, unit: 'each', unit_price: 80, est_minutes: null, notes: null, kind: 'service' },
]
const captured = captureBundleItems(QUOTE_LINES, IDX)

// ⭐⭐ A line priced straight off the catalogue stores NULL, not a copy. Storing
// the copy would make the first bundle an owner saves a second, FROZEN price
// list — and re-pricing a service in Settings would stop reaching new quotes.
eq('a catalogue-rate line stores no price of its own', captured[0].unit_price, null)
eq('a hand-priced catalogue line keeps the owner’s figure', captured[1].unit_price, 55)
eq('one-off work keeps its price', captured[2].unit_price, 80)
eq('the catalogue link survives capture', captured[0].service_template_id, 't-bed')
eq('sort order is assigned from the quote’s order', captured.map(c => c.sort_order), [0, 1, 2])
eq('an estimate survives', captured[0].est_minutes, 90)

// A round trip must not move the money.
eq('capture → apply is money-preserving',
  bundleTotal(captured.map((c, i) => I({ ...c, id: `r${i}`, name: c.name })), IDX),
  sumServiceLines(QUOTE_LINES.map(l => ({ ...l, discount_type: null, discount_value: null }))).net)

// A blank line is not a line.
eq('unnamed lines are dropped',
  captureBundleItems([{ ...QUOTE_LINES[0], service_type: '   ' }], IDX).length, 0)

eq('names are trimmed and collapsed', cleanBundleName('  Spring   Cleanup  '), 'Spring Cleanup')

// ── The COPY guarantee, asserted as an ABSENCE ───────────────────────────────
// If any of these ever appear, a bundle has become a live link and editing one
// could reach a quote that was already sent.
const SRC = ['src/lib/serviceBundles.ts', 'src/components/quotes/BundlePicker.tsx',
  'src/components/quotes/SaveAsBundleDialog.tsx', 'src/components/settings/ServiceBundles.tsx',
  'src/components/quotes/QuoteBuilder.tsx'].map(read).join('\n')
check('no quote column records which bundle it came from',
  !/quotes?\s*\.\s*bundle_id|bundle_id:\s*(quote|b\.id)/.test(SRC) && !/service_bundle_id/.test(SRC),
  'a bundle reference on a quote turns "delete a bundle" into a history-editing operation')
const TYPES = read('src/types/index.ts')
check('the Quote type has no bundle field',
  !/^\s*(service_)?bundle_id\??:/m.test(TYPES.slice(TYPES.indexOf('export interface Quote '), TYPES.indexOf('export interface Quote ') + 4000)),
  'Quote must not reference a bundle')

// ── The vocabulary stays three words ─────────────────────────────────────────
const LIB = read('src/lib/serviceBundles.ts')
check('the bundle lib never calls a bundle a template',
  !/\bbundleTemplate|templateBundle|BundleTemplate\b/.test(LIB))
check('…and states the three-noun rule where a reader will hit it',
  /ServiceTemplate\b[\s\S]{0,600}catalogue/i.test(read('src/types/index.ts')))

// ── Options and bundles cannot meet ──────────────────────────────────────────
const BUILDER = read('src/components/quotes/QuoteBuilder.tsx')
check('the picker is blocked on an options quote',
  /blockedReason=\{optionsOn/.test(BUILDER),
  'a quote holding options cannot hold service lines — the database refuses it')
const DETAIL = read('src/app/dashboard/quotes/[id]/page.tsx')
check('"Save as bundle" is hidden on an options quote',
  /!options\.length && \(/.test(DETAIL),
  'an options quote has no line items, so there is no scope to save')

// ── Applying must lock the suggestion engine out of the price ────────────────
// Otherwise the effect that writes a recommendation into `initial_price`
// overwrites the bundle's price on the very next render.
// Bounded to the FUNCTION, not to a character count. A fixed-width window ran
// past the end of applyBundle into the effect below it — which contains its own
// `setPriceOrigin('manual')` — so deleting the lock from applyBundle still
// passed. Caught by mutation-testing this guard, which is the only way that
// class of false pass ever shows up. `\n  }` is the two-space close of a
// component-level function; every block inside applyBundle is indented deeper.
const applyStart = BUILDER.indexOf('async function applyBundle')
const applyFn = applyStart < 0 ? '' : BUILDER.slice(applyStart, BUILDER.indexOf('\n  }', applyStart))
check('the guard can actually see applyBundle', applyFn.length > 200 && /toast\.success/.test(applyFn),
  'the slice below asserts on nothing if this fails')
check('applying a bundle marks the price as the owner’s', /setPriceOrigin\('manual'\)/.test(applyFn),
  "without this, the suggestion effect overwrites the bundle's price")
check('…and clears any picked cadence', /setPickedCadence\(null\)/.test(applyFn))
check('…and only sets hours when the bundle recorded one',
  /hours != null\) setValue\('hours'/.test(applyFn),
  'unknown hours is not zero hours')
check('applying replaces the scope rather than appending to it',
  /serviceLines\.replace\(/.test(applyFn))
// The whole shape, not just the word: gated on there being something to lose,
// awaited, and its ANSWER acted on. Asserting only that `confirm(` appears
// would pass a dialog whose result is thrown away — a confirm nobody reads is
// worse than none, because it looks like consent was taken.
check('…and asks first when there is something to lose, and honours the answer',
  /if \(hasScope\) \{[\s\S]{0,500}await confirm\(\{[\s\S]{0,500}if \(!ok\) return/.test(applyFn))

// ── Honest failure ───────────────────────────────────────────────────────────
const SAVE = read('src/components/quotes/SaveAsBundleDialog.tsx')
check('a failed bundle insert is reported, not swallowed',
  /if \(error \|\| !bundle\)[\s\S]{0,220}toast\.error/.test(SAVE))
check('a bundle whose LINES failed is taken back out',
  /if \(itemErr\)[\s\S]{0,260}service_bundles'\)\.delete\(\)/.test(SAVE),
  'a named bundle with no lines would sit in the picker offering nothing')
const MGR = read('src/components/settings/ServiceBundles.tsx')
check('a failed delete is not announced as a success',
  /if \(delErr\)[\s\S]{0,120}toast\.error/.test(MGR))
check('a failed READ never renders an empty list as fact',
  /still there, this list/.test(MGR) && /still there, this list/.test(read('src/components/quotes/BundlePicker.tsx')))
check('deleting says what happens to quotes already built from it',
  /not affected[\s\S]{0,80}own copy of the scope/.test(MGR))

// ── ⚠️ The PostgREST column-set trap that this feature walked into ───────────
// PostgREST unifies the COLUMN SET of a bulk insert and sends an explicit NULL
// for any key an object is missing — it does NOT fall back to the column
// default. Both quote-line write paths listed row 0 without `kind` and the
// extras with it, so row 0 arrived as NULL against a NOT NULL column and the
// whole insert was rejected: every multi-service quote saved with no breakdown
// at all, silently in the create path (its error was never read) and
// destructively in the edit path (which DELETEs first). Proven live: 0 rows
// written before the fix, 2 after. A bundle produces exactly this shape, so
// this is pinned here.
const NEW = read('src/app/dashboard/quotes/new/page.tsx')
const primaryRow = (src: string) => {
  const at = src.indexOf("from('quote_services').insert([")
  return at < 0 ? '' : src.slice(at, src.indexOf('...extraLines', at))
}
check('the create path names `kind` on the primary line', /kind: 'service'/.test(primaryRow(NEW)),
  'omitting it makes PostgREST send NULL and the whole breakdown is refused')
check('the edit path names `kind` on the primary line', /kind: 'service'/.test(primaryRow(DETAIL)))
check('the create path READS the line-insert error',
  /const \{ error: lineErr \} = await supabase\.from\('quote_services'\)\.insert\(\[/.test(NEW),
  'an unchecked insert is a breakdown the owner believes exists')
check('…and says the quote saved but its lines did not',
  /Saved the quote, but its service lines could not be written/.test(NEW))

// ── Mobile ───────────────────────────────────────────────────────────────────
check('picker rows are thumb-sized', /min-h-\[52px\]/.test(read('src/components/quotes/BundlePicker.tsx')))
check('manager rows are thumb-sized', /min-h-\[44px\]/.test(MGR))

// ═════════════════════════════════════════════════════════════════════════════
// LIVE — the copy guarantee, against the real database
// ═════════════════════════════════════════════════════════════════════════════
const BUNDLE_NAME = 'ZZ-VERIFY-BUNDLE'
const QUOTE_NUMBER = 'ZZ-VERIFY-BUNDLE-Q'

async function live() {
  console.log('\n═══ 5. Live: setup ═══')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const email = process.env.PORTAL_RPC_OWNER_EMAIL
  const password = process.env.PORTAL_RPC_OWNER_PASSWORD
  if (!url || !anonKey || !email || !password) {
    console.log('  – live checks skipped (no .env.local credentials); the static half above still ran')
    return
  }

  const owner: SupabaseClient = createClient(url, anonKey)
  const { data: auth, error: authErr } = await owner.auth.signInWithPassword({ email, password })
  if (authErr || !auth?.user) { fail('sign in as the owner', authErr?.message ?? 'no user'); return }
  const uid = auth.user.id
  ok('signed in as the owner')

  // Sweep any leftover from a killed run BEFORE creating this one.
  await owner.from('service_bundles').delete().eq('user_id', uid).eq('name', BUNDLE_NAME)
  await owner.from('quotes').delete().eq('user_id', uid).eq('quote_number', QUOTE_NUMBER)

  let bundleId: string | null = null
  let quoteId: string | null = null
  try {
    const { data: tpl } = await owner.from('service_templates').select('*').eq('user_id', uid).limit(1).single()
    if (!tpl) { fail('the business has a catalogue to bundle', 'no service_templates row'); return }

    const { data: b, error: bErr } = await owner.from('service_bundles')
      .insert({ user_id: uid, name: BUNDLE_NAME }).select('id').single()
    if (bErr || !b) { fail('create a bundle', bErr?.message); return }
    bundleId = b.id
    ok('create a bundle')

    const { error: iErr } = await owner.from('service_bundle_items').insert([
      { user_id: uid, bundle_id: bundleId, service_template_id: tpl.id, name: tpl.name, quantity: 2, unit: 'each', sort_order: 0 },
      { user_id: uid, bundle_id: bundleId, name: 'ZZ extra line', quantity: 1, unit: 'each', unit_price: 25, sort_order: 1 },
    ])
    check('add its lines', !iErr, iErr?.message)

    console.log('\n═══ 6. Live: the quote receives the scope ═══')
    const { data: items } = await owner.from('service_bundle_items').select('*').eq('bundle_id', bundleId).order('sort_order')
    const liveIdx = templateIndex([tpl as ServiceTemplate])
    const liveScope = bundleScope((items as ServiceBundleItem[]) || [], liveIdx)
    eq('the primary line is the catalogue service', liveScope.primary?.service_type, tpl.name)
    eq('…priced 2 × the catalogue rate', liveScope.primary?.price, Math.round(2 * Number(tpl.default_rate) * 100) / 100)
    eq('…and the typed line kept its own price', liveScope.extras[0]?.unit_price, 25)

    const primaryNet = Number(liveScope.primary?.price ?? 0)
    const { data: q, error: qErr } = await owner.from('quotes').insert({
      user_id: uid, quote_number: QUOTE_NUMBER, customer_name: 'ZZ Verify', address: 'ZZ',
      service_type: liveScope.primary!.service_type, service_template_id: liveScope.primary!.service_template_id || null,
      initial_price: primaryNet + sumServiceLines(liveScope.extras).net,
      hours: 0, crew_size: 1, rate: 0, travel_fee: 0, status: 'draft',
    }).select('id, initial_price, total').single()
    if (qErr || !q) { fail('build a quote from the bundle', qErr?.message); return }
    quoteId = q.id
    ok('build a quote from the bundle')

    const { error: lErr } = await owner.from('quote_services').insert([
      // `kind` on BOTH — see the column-set trap pinned in section 4.
      { user_id: uid, quote_id: quoteId, sort_order: 0, service_type: liveScope.primary!.service_type,
        service_template_id: liveScope.primary!.service_template_id || null, quantity: 1, unit: 'each',
        unit_price: primaryNet, kind: 'service' },
      ...liveScope.extras.map((e, i) => ({
        user_id: uid, quote_id: quoteId, sort_order: i + 1, service_type: e.service_type,
        service_template_id: e.service_template_id || null, quantity: e.quantity, unit: e.unit, unit_price: e.unit_price, kind: e.kind,
      })),
    ])
    check('the scope lands as ordinary quote lines', !lErr, lErr?.message)

    const quotedTotal = Number(q.total)

    console.log('\n═══ 7. Live: changing the quote does not change the bundle ═══')
    await owner.from('quote_services').update({ unit_price: 999 }).eq('quote_id', quoteId).eq('sort_order', 1)
    const { data: afterQuoteEdit } = await owner.from('service_bundle_items').select('unit_price').eq('bundle_id', bundleId).eq('sort_order', 1).single()
    eq('the bundle line is untouched by the quote edit', Number(afterQuoteEdit?.unit_price), 25)

    console.log('\n═══ 8. Live: changing or deleting the bundle does not change the quote ═══')
    await owner.from('service_bundle_items').update({ unit_price: 1 }).eq('bundle_id', bundleId).eq('sort_order', 1)
    await owner.from('service_bundles').update({ name: BUNDLE_NAME + ' renamed' }).eq('id', bundleId)
    const { data: q2 } = await owner.from('quotes').select('total, service_type').eq('id', quoteId).single()
    eq('the quote total survives the bundle edit', Number(q2?.total), quotedTotal)
    eq('…and so does its service name', q2?.service_type, liveScope.primary?.service_type)

    // ⭐ THE ONE AN OWNER WILL ACTUALLY WORRY ABOUT.
    const { error: dErr } = await owner.from('service_bundles').delete().eq('id', bundleId)
    check('the bundle deletes', !dErr, dErr?.message)
    const { data: q3 } = await owner.from('quotes').select('total, service_type').eq('id', quoteId).single()
    const { count: lineCount } = await owner.from('quote_services').select('id', { count: 'exact', head: true }).eq('quote_id', quoteId)
    eq('DELETING THE BUNDLE leaves the quote total intact', Number(q3?.total), quotedTotal)
    eq('…leaves its lines intact', lineCount, 1 + liveScope.extras.length)
    eq('…and leaves its service name intact', q3?.service_type, liveScope.primary?.service_type)
    const { count: orphanItems } = await owner.from('service_bundle_items').select('id', { count: 'exact', head: true }).eq('bundle_id', bundleId)
    eq('…while the bundle’s own lines are gone with it', orphanItems, 0)
    bundleId = null
  } finally {
    console.log('\n═══ 9. Live: cleanup ═══')
    if (quoteId) await owner.from('quotes').delete().eq('id', quoteId)
    if (bundleId) await owner.from('service_bundles').delete().eq('id', bundleId)
    await owner.from('service_bundles').delete().eq('user_id', uid).like('name', BUNDLE_NAME + '%')
    await owner.from('quotes').delete().eq('user_id', uid).eq('quote_number', QUOTE_NUMBER)
    const { count: leftB } = await owner.from('service_bundles').select('id', { count: 'exact', head: true }).like('name', BUNDLE_NAME + '%')
    const { count: leftQ } = await owner.from('quotes').select('id', { count: 'exact', head: true }).eq('quote_number', QUOTE_NUMBER)
    check('the guard cleaned up after itself', (leftB ?? 0) === 0 && (leftQ ?? 0) === 0,
      `${leftB} bundle(s) and ${leftQ} quote(s) remain — delete them by hand`)
    await owner.auth.signOut().catch(() => {})
  }
}

live()
  .catch(e => { fail('the guard itself could not run', String(e?.message ?? e)) })
  .finally(() => {
    console.log('\n── Summary ────────────────────────────────────────────────────')
    console.log(failures === 0
      ? '\n✅ verify:service-bundles — a bundle seeds a quote, the catalogue keeps the price, and neither can reach back into the other\n'
      : `\n❌ verify:service-bundles — ${failures} contract${failures === 1 ? '' : 's'} broken\n`)
    process.exit(failures === 0 ? 0 : 1)
  })
