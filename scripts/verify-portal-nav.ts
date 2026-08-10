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
    /tab === 'messages' &&[^]*?<RequestsTab[^]*?<MessagesTab/.test(CLIENT), true)
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
    /function resolveTab\(t: TabKey\): TabKey \{\s*return t === 'requests' \? 'messages' : t/.test(CLIENT), true)
  // TWO places set the tab, and only one of them is goTab. The deep-link effect
  // calls setTab DIRECTLY — it was missed on the first pass, which would have
  // shipped a blank portal to exactly the people holding an old ?tab=requests
  // link. Assert EVERY setTab that takes a variable goes through the resolver.
  {
    const sites = [...CLIENT.matchAll(/setTab\(([^)]*)\)/g)].map(m => m[1].trim())
    const unresolved = sites.filter(a =>
      !a.startsWith("'") && !a.startsWith('resolveTab(') && a !== 'next')
    check('every setTab of a dynamic key is resolved (none bypass the alias)', unresolved, [])
  }
  check('goTab resolves its argument', /const next = resolveTab\(rawNext\)/.test(CLIENT), true)
  check('the deep-link effect resolves too', /setTab\(resolveTab\(link\.tab\)\)/.test(CLIENT), true)
  check('a bogus tab still parses to null (unchanged)',
    parsePortalDeepLink('?tab=nonsense').tab, null)
  check('?tab=billing is untouched', parsePortalDeepLink('?tab=billing').tab, 'billing')
}

H('4. KEYBOARD NAV STILL WALKS THE WHOLE (SHORTER) BAR')
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
