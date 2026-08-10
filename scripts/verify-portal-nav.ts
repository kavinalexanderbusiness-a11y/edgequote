// ── Portal navigation & Home ordering — npm run verify:portal-nav ────────────
//
// WHY THIS EXISTS
// The customer portal is opened from a text message by a homeowner who has never
// seen it before. Rendered against five REAL production portals, the first eight
// lines of every single one were the same provider card — name, company,
// "Customer since", Call/Email/Website — before anything about that customer:
//
//   Tanya (3 quotes awaiting approval) → "Your provider…" then the quotes
//   Laura ($347.50 due)                → "Your provider…" then the amount
//   Maggie (recurring)                 → "Your provider…" then the next visit
//
// The page header already carries the logo and company name, so the top of the
// screen answered "who are you" twice before "what do I need to do" — on a phone
// the answer was below the fold in every state.
//
// This pins the two structural rules that fixed it. They are ordering/wiring
// facts, which is exactly what a source-level guard can hold; the money itself is
// owned by the deposit/ledger engines and their own suites, and nothing here
// re-derives a figure.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePortalDeepLink, tabNavTarget } from '../src/app/portal/[token]/model'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const ROOT = join(__dirname, '..')
const portal = (f: string) => readFileSync(join(ROOT, 'src/app/portal/[token]', f), 'utf8')

const HOME = portal('components/HomeTab.tsx')
const CLIENT = portal('PortalClient.tsx')

// ═══════════════════════════════════════════════════════════════════════════
H('1. HOME IS ACTION-FIRST — the customer’s situation outranks the provider card')

{
  // The three anchors, in the order they must appear in the rendered tree.
  const attention = HOME.indexOf('{payFirst && dueBanner}')
  const quotes = HOME.indexOf('awaiting.length > 0 &&')
  const trust = HOME.indexOf('<TrustCard view={view} />')

  check('all three anchors still exist (the file was not restructured out from under this)',
    attention > 0 && quotes > 0 && trust > 0, true)
  check('the money banner renders BEFORE the provider card', attention < trust, true)
  check('the quote-approval card renders BEFORE the provider card', quotes < trust, true)
  // …and below the next-service hero too, so "what is happening next" — the
  // question every calm portal has to answer — also beats the provider card.
  const hero = HOME.indexOf('>Next service</p>')
  check('the next-service hero renders BEFORE the provider card',
    hero > 0 && hero < trust, true)
  check('the provider card is still rendered somewhere (moved, not deleted)',
    trust > 0, true)
}

// ═══════════════════════════════════════════════════════════════════════════
H('2. ONE WAY TO REACH A HUMAN — Requests folded into Contact')

{
  // The pill list must no longer offer 'requests' as its own destination.
  check('no separate "Requests" pill in the tab bar',
    /\{ key: 'requests', label:/.test(CLIENT), false)
  check('the messages pill is labelled for a homeowner ("Contact")',
    /\{ key: 'messages', label: 'Contact'/.test(CLIENT), true)
  // Both panels must render together, or half the destination silently vanishes.
  check('Contact renders the service catalogue AND the message thread',
    /activeTab === 'messages' &&[\s\S]{0,400}?<RequestsTab[\s\S]{0,400}?<MessagesTab/.test(CLIENT), true)
  check('there is no longer a standalone requests panel',
    /\{tab === 'requests' && <RequestsTab/.test(CLIENT), false)
}

H('3. OLD LINKS STILL LAND — a folded tab must not blank the panel')
{
  // `requests` stays a VALID deep-link key (comms links and Home's "Request a
  // service" both use it); goTab redirects it. If the key were dropped from the
  // union instead, ?tab=requests would select a tab with no panel and no pill.
  check('?tab=requests still parses to a real tab rather than null',
    parsePortalDeepLink('?tab=requests').tab, 'requests')
  check('the alias lives in ONE resolver, not inlined per call site',
    /function resolveTab\(t: TabKey, multiProperty: boolean\): TabKey/.test(CLIENT), true)
  // The resolution happens at RENDER, against the loaded payload — not at setTab
  // time. Two call sites set the tab (goTab and the deep-link effect, which calls
  // setTab DIRECTLY), and the deep-link one can run before a non-SSR-seeded load
  // returns; resolving there would decide a landlord's ?tab=property on a guess.
  // So `tab` stores the RAW ask and `activeTab` is what the UI reads.
  check('a single activeTab is derived from the raw tab', /const activeTab = resolveTab\(tab, multiProperty\)/.test(CLIENT), true)
  check('goTab resolves for the URL it writes', /const next = resolveTab\(rawNext, multiProperty\)/.test(CLIENT), true)
  // The whole point: nothing may render off the RAW key, or a folded destination
  // shows a pill/panel mismatch. Every tab comparison must read activeTab.
  {
    const raw = [...CLIENT.matchAll(/\btab === '(\w+)'/g)]
      .filter(m => !/activeTab === /.test(CLIENT.slice(Math.max(0, m.index! - 6), m.index! + 4)))
    check('no render path compares the RAW tab (all use activeTab)', raw.map(m => m[0]), [])
  }
  check('the panel is labelled by the resolved tab',
    /aria-labelledby=\{`porttab-\$\{activeTab\}`\}/.test(CLIENT), true)
  check('a bogus tab still parses to null (unchanged)',
    parsePortalDeepLink('?tab=nonsense').tab, null)
  check('?tab=billing is untouched', parsePortalDeepLink('?tab=billing').tab, 'billing')
}

H('4. PROPERTY FOLDS INTO VISITS — for a single address only')
{
  const VISITS = portal('components/VisitsTab.tsx')
  const PROP = portal('components/PropertyTab.tsx')
  // 50 of 55 production portals are single-property. For them the Property pill
  // held an address they already know; the work at that address lived elsewhere.
  check('the Properties pill shows ONLY for a multi-property customer',
    /t\.key === 'property' \? \(view\.hasProperty && view\.multiProperty\)/.test(CLIENT), true)
  check('?tab=property lands on Visits for a single-address customer',
    /t === 'property' && !multiProperty\) return 'visits'/.test(CLIENT), true)
  // …but a landlord keeps the destination, because grouping the work BY address
  // is the information. Forcing that into one Visits list is what the brief
  // warned about, so the resolver leaves it alone.
  check('…and a landlord keeps Properties (the alias is conditional)',
    /if \(t === 'property' && !multiProperty\)/.test(CLIENT), true)
  check('Visits leads with the property summary for a single-address customer',
    /!view\.multiProperty && view\.hasProperty[\s\S]{0,200}?<PropertySummary/.test(VISITS), true)
  check('…and renders nothing extra for a landlord (no double render)',
    /propertyLead/.test(VISITS) && /!view\.multiProperty/.test(VISITS), true)
  check('the summary carries address, measurements and the provider note',
    /<PropertyHeader[\s\S]{0,300}<FactsRow[\s\S]{0,200}NotesCard/.test(PROP), true)
  // Relocating a duplicate is not removing one: Home already lists the same
  // recurrences under "Your service plan".
  check('the summary does NOT re-list the plans Home already shows',
    /export function PropertySummary[\s\S]{0,900}?PlanLine/.test(PROP), false)
}

H('5. HOME NO LONGER SAYS THE SAME THING TWICE')
{
  // The hero states the next visit in large type with a days-away gloss; the plan
  // card three cards down printed the identical date.
  check('the plan card knows the hero’s date', /function PlanRow\(\{ p, heroDate \}/.test(HOME), true)
  check('…and suppresses the date when it merely echoes the hero',
    /const echoesHero = !!heroDate && p\.nextVisitDate === heroDate/.test(HOME), true)
  check('…while a plan with a DIFFERENT next visit still shows its own date',
    /echoesHero \? \([\s\S]{0,400}?\) : \([\s\S]{0,200}?Next visit /.test(HOME), true)
  check('the hero’s date is what gets passed down',
    /heroDate=\{next\?\.scheduled_date \?\? null\}/.test(HOME), true)

  // Recent activity is HISTORY; the attention area owns anything still pending.
  check('quotes awaiting approval are kept out of the history feed',
    /awaitingQuoteIds\.has\(q\.id\)\) continue/.test(HOME), true)
  check('the invoice currently being asked for is kept out too',
    /dueInvoiceIds\.has\(d\.id\)\) continue/.test(HOME), true)
  check('…and only while the banner is actually shown (money.due > 0)',
    /view\.money\.due > 0\s*\?[\s\S]{0,260}?: \[\]/.test(HOME), true)
  // DocItem.balance is POSITIVE on a cancelled invoice — an owing filter that
  // forgets status would suppress a cancelled document from the history for no
  // reason. (Same trap the deposit work documented.)
  check('the owing filter excludes cancelled/paid, not just balance > 0',
    /d\.status !== 'paid' && d\.status !== 'overpaid' && d\.status !== 'cancelled'/.test(HOME), true)
  // A FUTURE visit is not "recent activity" — the hero states it at the top of the
  // same page and Visits lists every one. A past visit that never completed IS
  // history and must survive.
  check('upcoming visits are kept out of the history feed',
    /j\.scheduled_date > view\.todayISO\) continue/.test(HOME), true)
  check('…but a completed visit is still recorded first',
    HOME.indexOf("status === 'completed'") < HOME.indexOf('j.scheduled_date > view.todayISO'), true)
}

H('6. KEYBOARD NAV STILL WALKS THE WHOLE (SHORTER) BAR')
{
  // The bar wraps to two rows, so both axes move — with one fewer pill the
  // wrap-around arithmetic has to keep holding at the new count.
  check('ArrowRight wraps from the last pill to the first (5 pills)', tabNavTarget('ArrowRight', 4, 5), 0)
  check('ArrowLeft wraps from the first pill to the last (5 pills)', tabNavTarget('ArrowLeft', 0, 5), 4)
  check('Home key jumps to the first pill', tabNavTarget('Home', 3, 5), 0)
  check('End key jumps to the last pill', tabNavTarget('End', 0, 5), 4)
  check('an unrelated key does nothing', tabNavTarget('a', 1, 5), null)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${fail === 0 ? '✅' : '❌'} portal nav: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
