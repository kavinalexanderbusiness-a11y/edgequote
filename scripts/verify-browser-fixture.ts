// ── Verify: the S122 browser fixture is safe, honest, and renders the real UI ─
//   npm run verify:browser-fixture
//
// ⚠️⚠️ WHAT THIS IS NOT. **It is not a browser pass**, and it must never be
// reported as one. It renders the shipping components to a DOM STRING in Node:
// no layout, no CSS, no viewport, no click, no focus, no overflow. A sentence can
// be present in the markup and still be invisible, clipped, or unreachable on a
// 375px screen — which is precisely the class of thing only a browser catches.
//
// ⭐ What it IS, and why it is worth having while the heavy slot is held: it is
// strictly stronger than a source assertion. The strings it checks are produced
// by `BillingTab`, `buildPortalView` and `RecordAcceptanceDialog` themselves, from
// the fixture's own props — so if someone reverts the repair, this goes red
// without anyone opening Chrome. The browser half is scripts/s122-fixture-cdp.mjs
// and remains OUTSTANDING until the coordinator runs it.
//
// ⛔ No database, no network, no dev server, no credential, no browser.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Type-only, so it is erased and cannot import the module before the React
// global below is in place — the components must be reached dynamically.
import type { FixtureKind } from '../src/app/dev/s122-fixture/fixtureData'

// The app's components are compiled with the classic JSX runtime under tsx, so
// they call React.createElement from module scope. Providing the global BEFORE
// they are imported is what lets them render here at all — hence the dynamic
// imports below, which must stay dynamic.
;(globalThis as unknown as { React: typeof React }).React = React

let pass = 0, fail = 0
const check = (n: string, ok: boolean, d?: string) => {
  if (ok) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.error(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
}
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const DIR = 'src/app/dev/s122-fixture'
const PAGE = `${DIR}/page.tsx`
const CLIENT = `${DIR}/S122Fixture.tsx`
const DATA = `${DIR}/fixtureData.ts`
const CDP = 'scripts/s122-fixture-cdp.mjs'
const SERVE = 'scripts/s122-fixture-serve.mjs'

async function main() {
  console.log('\n══ S122 browser fixture ════════════════════════════════════════════\n')

  console.log('■ 1. The route cannot exist anywhere it should not')
  {
    const page = read(PAGE)
    check('production is refused outright',
      /process\.env\.NODE_ENV === 'production'\) notFound\(\)/.test(page))
    check('…and every other environment still needs a deliberate opt-in',
      /process\.env\.S122_FIXTURE !== '1'\) notFound\(\)/.test(page))
    check('⛔ neither lock can be flipped by a request',
      !/searchParams|headers\(\)|cookies\(\)|req\./.test(page),
      'a fixture reachable by query string is a fixture reachable by anyone')
    const all = page + read(CLIENT) + read(DATA)
    check('⛔ the fixture holds no database client and no credential',
      !/supabase|SERVICE_ROLE|ANON_KEY|process\.env\.[A-Z_]*KEY/.test(all))
  }

  console.log('\n■ 2. ⭐⭐ It shows the REAL UI, not a retyped copy of it')
  {
    const src = read(CLIENT) + read(DATA)
    // ⛔ Every scoped assertion's container must hold ONLY product output. The
    // captions describe the scenes and must therefore sit OUTSIDE the id.
    check('⛔ the scene id wraps the component alone, never the caption',
      /<div id=\{s\.id\} className="rounded-xl border border-border p-3">\s*\n\s*<BillingTab/.test(read(CLIENT)),
      'a scope that contains its own description measures the description')
    check('it imports the shipping components, from where the app imports them',
      /from '@\/app\/portal\/\[token\]\/components\/BillingTab'/.test(src)
      && /from '@\/components\/quotes\/RecordAcceptanceDialog'/.test(src)
      && /from '@\/app\/portal\/\[token\]\/model'/.test(src))
    // ⛔ THE ANTI-MOCK RULE. Every sentence under test is owned by a component or
    // by lib/quoteAcceptance. If any of them appears in the fixture's own source,
    // the fixture is drawing the answer instead of asking for it — and a green
    // browser run would then be proving the fixture, not the product.
    const COMPONENT_OWNED = [
      // ⛔ 'you accepted' on its own, not just the portal's longer sentence: the
      // first browser run failed because a CAPTION said `never "you accepted"`
      // inside the scope an assertion measured. A forbidden string is forbidden
      // in the fixture even when it appears as a description of the rule.
      'you accepted',
      'on your behalf',
      'record of your acceptance',
      'take its deposit online',
      'This quote changed after it was marked Accepted',
      'No acceptance naming who agreed is on file',
      'Previous unsupported acceptance figure',
      'Confirm acceptance of',
    ]
    for (const s of COMPONENT_OWNED) {
      check(`⛔ the fixture does not restate — "${s.slice(0, 42)}"`, !src.includes(s),
        'this sentence must come from the component under test')
    }
  }

  console.log('\n■ 3. The transport is deny-by-default')
  {
    const src = read(CLIENT)
    check('exactly two routes are answered',
      (src.match(/url\.includes\('\/api\//g) || []).length === 2)
    check('…and they are the two owner-acceptance routes',
      /url\.includes\('\/api\/quotes\/record-acceptance'\)/.test(src)
      && /url\.includes\('\/api\/quotes\/confirm-current-acceptance'\)/.test(src))
    check('⛔ anything else THROWS rather than reaching the network',
      /onViolation\(\{ url, method \}\)/.test(src) && /throw new Error\(`S122 fixture: refusing a real request/.test(src))
    check('…and the refusals are shown on the page, for a run to assert on',
      /id="fixture-network"/.test(src))
    check('⭐ the honest control: payments are ENABLED on the fixture',
      /paymentsEnabled: true/.test(src) && /paymentPending: false/.test(src),
      'with payments off, a missing Pay button would pass for the wrong reason')
  }

  console.log('\n■ 4. ⭐ The scenes, RENDERED by the shipping components')
  {
    const { buildPortalView } = await import('../src/app/portal/[token]/model')
    const { BillingTab } = await import('../src/app/portal/[token]/components/BillingTab')
    const { fixtureData, FIXTURE_TODAY } = await import('../src/app/dev/s122-fixture/fixtureData')

    const renderers = { quote: async () => new Blob(), invoice: async () => new Blob() }
    // Inert by construction: any action the component calls is a no-op, and the
    // three flags that gate the Pay affordance are set the permissive way.
    const actions = new Proxy(
      { paymentsEnabled: true, paymentPending: false, payingQuoteId: null, accepting: null, payingId: null, decidingChangeId: null, token: 'zz-fixture-token' } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => {}) },
    ) as never
    const scene = (kind: FixtureKind) => renderToStaticMarkup(React.createElement(BillingTab, {
      view: buildPortalView(fixtureData(kind), FIXTURE_TODAY, renderers), actions,
    }))
    // Markup, not text: entities differ, so compare on a normalised plain string.
    const text = (html: string) => html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')

    {
      const t = text(scene('legacy_unrecorded'))
      check('legacy · the deposit reason is rendered', /take its deposit online/.test(t), t.slice(0, 200))
      check('legacy · ⛔ no Pay button is rendered', !/Pay \$/.test(t))
      check('legacy · the $250 ask still stands', /\$250/.test(t))
      check('legacy · ⛔ the raw-snapshot $700 is nowhere', !/700/.test(t))
      check('legacy · ⛔ nor the unproven $1,400', !/1,400/.test(t))
      check('legacy · ⛔ and it never says "you accepted"', !/you accepted/i.test(t))
    }
    {
      const t = text(scene('customer'))
      check('customer · the consent snapshot IS shown', /1,400/.test(t))
      check('customer · …with the only sentence allowed to claim it',
        /price you accepted/.test(t))
      check('customer · the Pay button is rendered', /Pay \$700/.test(t),
        'the strip must stay conditional — an always-strip regression lands here')
    }
    {
      const t = text(scene('owner_on_behalf'))
      check('on-behalf · the agreed figure is shown', /1,400/.test(t))
      check('on-behalf · worded as the business’s record', /on your behalf/.test(t))
      check('on-behalf · ⛔ never in the customer’s voice', !/you accepted/i.test(t))
    }
    {
      const t = text(scene(null))
      check('unevidenced · says plainly there is no record', /record of your acceptance/.test(t))
      check('unevidenced · shows the CURRENT price only', /\$500/.test(t) && !/1,400/.test(t))
      check('unevidenced · ⛔ no Pay button', !/Pay \$/.test(t))
    }

    // ── ⭐⭐ The PDF seam, which is where the timing sentence actually lands ──
    // ⚠️ MEASURED, NOT ASSUMED: on an ACCEPTED quote the timing sentence is not a
    // DOM surface at all. BillingTab renders `explain` only while a quote can
    // still be accepted, and HomeTab's `paymentTimingLine` only on the approve
    // card — so the "$700 against a $500 quote" half of the original defect
    // reaches the customer through the PDF they download, and nowhere else in the
    // portal HTML. The model still carries the right sentence (asserted here), and
    // the document is fed the right basis (asserted below).
    {
      const view = buildPortalView(fixtureData('legacy_unrecorded'), FIXTURE_TODAY, renderers)
      const row = view.docItems.find(d => d.kind === 'quote')!
      check('the model’s timing sentence names the honest $250',
        /\$250\.00/.test(row.paymentTimingLine ?? ''), row.paymentTimingLine)
      check('⛔ …and never the raw-snapshot $700', !/700/.test(row.paymentTimingLine ?? ''))
      const html = renderToStaticMarkup(React.createElement(BillingTab, { view, actions }))
      check('⚠️ …while the portal HTML does not render it on an accepted quote',
        !/before we schedule your visit/.test(text(html)),
        'stated so nobody reads this fixture as covering a surface that does not exist')
    }
    {
      // The SHIPPING `getBlob` closure, asked what it hands the renderer.
      const seen: (number | null)[] = []
      const recording = { quote: async (q: { accepted_price?: number | string | null }) => { seen.push(q.accepted_price == null ? null : Number(q.accepted_price)); return new Blob() }, invoice: async () => new Blob() }
      for (const kind of ['legacy_unrecorded', 'customer', 'owner_on_behalf', null] as FixtureKind[]) {
        const v = buildPortalView(fixtureData(kind), FIXTURE_TODAY, recording as never)
        await v.docItems.find(d => d.kind === 'quote')!.getBlob!()
      }
      check('⛔ the customer’s PDF is handed NO snapshot when nobody is named',
        seen[0] === null && seen[2 + 1] === null, JSON.stringify(seen))
      check('…and the agreed figure when somebody is',
        seen[1] === 1400 && seen[2] === 1400, JSON.stringify(seen))
    }
  }

  console.log('\n■ 5. The owner dialog mounts on its first step')
  {
    const { RecordAcceptanceDialog } = await import('../src/components/quotes/RecordAcceptanceDialog')
    const html = renderToStaticMarkup(React.createElement(RecordAcceptanceDialog, {
      open: true, onClose: () => {}, quoteId: 'zz-quote-1', quoteNumber: 'ZZ-2026-0152',
      customerName: 'ZZ Fixture Customer', travelFee: 0, total: 500, options: [],
      termsText: 'ZZ terms', selectedAddonsTotal: 0, onRecorded: () => {},
    }))
    const t = html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ')
    check('the reason question is asked, with no default', /How did they tell you\?/.test(t))
    check('…and it says whose act this is', /you\s*<?\/?\w*>?\s*wrote it down for them/.test(t) || /wrote it down for them/.test(t))
    check('the first-step button names the figure', /Record acceptance — \$500/.test(t), t.slice(0, 300))
    // ⚠️ The REPAIR panel is deliberately NOT asserted here. It only exists after
    // a request/response round trip, so reaching it needs a browser — which is
    // exactly the gap scripts/s122-fixture-cdp.mjs fills and this file must not
    // pretend to cover.
    check('⛔ the repair panel is NOT reachable without interaction',
      !/Confirm acceptance of/.test(t),
      'if this ever renders at mount, the fixture would be showing a state nobody reached')
  }

  console.log('\n■ 6. The browser run exists and asserts the safety readouts')
  {
    const cdp = read(CDP)
    check('it drives the fixture route', /\/dev\/s122-fixture/.test(cdp))
    check('it covers desktop and the three phone widths',
      /WIDTHS = \[1280, 430, 390, 375\]/.test(cdp))
    check('it drives BOTH owner shapes', /for \(const shape of \['unnamed', 'revised'\]\)/.test(cdp))
    // ⚠️ Checked against the CODE, not the prose. The header of that file SAYS it
    // reads no .env.local, and a naive scan matches its own promise — a check
    // that a comment can satisfy is a check a comment can also defeat.
    // ⛔ Line comments are stripped BEFORE trailing ones, and a trailing `//` is
    // only stripped when it does not follow `:` or a quote, so `http://` survives.
    const code = cdp.replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"])\/\/[^\n]*/g, '$1')
    check('⛔ it reads no credential and no .env.local',
      !/\.env\.local|SERVICE_ROLE|ANON_KEY|createClient/.test(code),
      code.split('\n').filter(l => /\.env\.local|SERVICE_ROLE|ANON_KEY|createClient/.test(l)).join(' | '))
    check('…and the stripper actually removed something (it is not a no-op)',
      code.length < cdp.length - 400)
    check('⛔ it fails on any network violation the page recorded',
      /violations: 0/.test(cdp) && /nothing left the browser/.test(cdp))
    // ⚠️ Anchored to the CALL, not the string. A mutation that turned this into
    // `ok(...)` left the message untouched and a presence check stayed green —
    // the existence-vs-behaviour trap this lane has hit before.
    check('⛔ a blank page is a FAILURE, never a passing absence',
      /fail\(`PAGE DID NOT RENDER/.test(cdp))
    check('it asks the PDF seam what it was handed', /fixture-pdf/.test(cdp))
    check('it presses the REAL controls rather than submitting itself',
      /clickText\('They replied by text'\)/.test(cdp) && /clickText\('Record acceptance'\)/.test(cdp))
    check('…and proves the confirm step refuses before the owner attests',
      /confirming is refused before the owner attests/.test(cdp))
    check('BOTH owner shapes run at every width, not a reduced pair',
      /for \(const w of WIDTHS\) \{/.test(cdp)
      && !/for \(const w of \[1280, 375\]\)/.test(cdp))
    check('it records the fixture AND product SHA the run is evidence for',
      /FIXTURE_SHA/.test(cdp) && /PRODUCT_SHA/.test(cdp))
    check('⛔ …and refuses to be evidence for a DIRTY worktree',
      /the worktree is DIRTY — this run is not evidence for a named SHA/.test(cdp))
  }

  console.log('\n■ 7. ⛔ Nothing can reach anything real')
  {
    const cdp = read(CDP)
    const serve = read(SERVE)

    // ⚠️ A literal `includes`, not a regex. The line under test is itself a regex
    // full of escapes, and a guard that has to escape an escape is a guard nobody
    // can read — and one whose failure teaches nothing about the code.
    check('the run refuses any base that is not loopback',
      cdp.includes('is not a loopback address')
      && cdp.includes('|localhost|') && cdp.includes('process.exit(2)'),
      'no backslashes in this assertion on purpose — see the note above')
    check('Chrome is started with an ALLOWLISTED env, not the inherited one',
      /const chromeEnv = Object\.fromEntries\(Object\.entries\(process\.env\)\.filter\(\(\[k\]\) => CHROME_ALLOW\.includes\(k\)\)\)/.test(cdp)
      && /env: chromeEnv/.test(cdp))
    check('…and its debugging socket is pinned to loopback',
      /--remote-debugging-address=127\.0\.0\.1/.test(cdp))
    // ⭐⭐ The egress claim is Chrome's, not the page's. A page that lied about
    // its own counter would still be caught by the protocol log.
    check('⭐ every request is recorded from the PROTOCOL and must be loopback',
      /Network\.enable/.test(cdp)
      && /m\.method === 'Network\.requestWillBeSent'/.test(cdp)
      && /every request the browser made was loopback/.test(cdp))

    check('the server launcher REFUSES to start beside a .env.local',
      /REFUSING TO START: \$\{f\} exists in this worktree/.test(serve)
      && /'\.env\.local', '\.env\.development\.local', '\.env\.production\.local', '\.env'/.test(serve))
    check('…builds its env from an allowlist rather than filtering a denylist',
      /const env = Object\.fromEntries\(Object\.entries\(process\.env\)\.filter\(\(\[k\]\) => ALLOW\.includes\(k\)\)\)/.test(serve))
    check('…points the only two vars the middleware reads at a closed local port',
      /NEXT_PUBLIC_SUPABASE_URL = 'http:\/\/127\.0\.0\.1:1'/.test(serve)
      && /NEXT_PUBLIC_SUPABASE_ANON_KEY = 'zz-synthetic-invalid-anon-key'/.test(serve))
    check('⛔ …and never sets a service role or a payment key',
      !/SERVICE_ROLE\s*=|STRIPE_[A-Z_]*\s*=/.test(serve))
    check('…and binds loopback only', /'--hostname', '127\.0\.0\.1'/.test(serve))

    // ⭐ The run instructions claim `/dev/*` needs no session and tolerates absent
    // credentials. That claim is enforced here against the middleware itself, so
    // it cannot quietly stop being true.
    const mw = read('src/middleware.ts')
    const sess = read('src/lib/supabase/middleware.ts')
    check('the middleware gates only the owner, crew and login paths',
      /const gated = isOwnerPath\(pathname\) \|\| isCrewPath\(pathname\) \|\| pathname === '\/login'/.test(sess),
      'if this widens to /dev, the fixture would start needing a session')
    check('…and an unreachable auth server passes the request through untouched',
      /if \(auth\.kind === 'unavailable'\) return supabaseResponse/.test(sess),
      'this is what makes a synthetic, closed-port Supabase URL safe rather than fatal')
    check('…and the only redirect above it is the canonical-host hop',
      /canonicalRedirectTarget/.test(mw))
  }

  console.log(fail > 0 ? `\n✗ ${fail} FAILURE(S) — ${pass} passed` : `\n✓ browser-fixture: ${pass} checks passed (⚠️ NOT a browser pass — see the header)`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
