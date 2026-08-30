// ── Failed read ≠ believable answer — npm run verify:data-honesty ────────────
//
// ONE defect shape, found in production over and over:
//
//   a Supabase read fails → supabase-js RESOLVES {data: null, error} (it does not
//   throw) → the caller writes `data || []` → the screen renders a perfectly
//   believable empty, $0, healthy, complete or all-clear state.
//
// The app then tells the owner something it does not know, in the most
// reassuring possible words. It has already caused: Dispatch showing zero crews,
// Workforce implying nobody works here, Grow saying nobody needs attention,
// unpaid balances reading $0, Win/Loss vanishing, Data Quality grading a dead
// database "A".
//
// ⚠️ THIS GUARD DOES NOT BAN `|| []`. That coercion is CORRECT for enrichment —
// optional metadata that can disappear without changing the authoritative
// answer, and several protected files below still use it deliberately. What is
// pinned here is narrower and permanent: the seams where a failed read would
// change a MONEY answer, a DOCUMENT IDENTITY, or a "you have nothing to worry
// about" verdict must keep telling failure and emptiness apart.
//
// Each section names the lie the code used to tell, so a future reader can judge
// whether a change is a regression or a deliberate redesign.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
function H(t: string) { console.log(`\n═══ ${t} ═══`) }
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${e}\n     actual:   ${a}`) }
}
const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const INVOICING = read('src/lib/invoicing.ts')
const NEW_INVOICE = read('src/components/payments/NewInvoiceDialog.tsx')
const QUOTE_DETAIL = read('src/app/dashboard/quotes/[id]/page.tsx')
const QUOTE_LIST = read('src/components/quotes/QuoteList.tsx')
const QUOTE_NEW = read('src/app/dashboard/quotes/new/page.tsx')
const SUGG_LOAD = read('src/lib/suggestionsLoad.ts')
const SUGG_UI = read('src/components/grow/SuggestionsCenter.tsx')
const REVINTEL = read('src/lib/revenueIntelligence.ts')
const REACT_PAGE = read('src/app/dashboard/reactivation/page.tsx')

// ═══════════════════════════════════════════════════════════════════════════
// 1. DOCUMENT NUMBERS — the highest-cost instance of the bug
//
// The lie: `nextInvoiceNumber` read every existing invoice_number and took the
// highest. A failed read coerced to [] means "you have no invoices", so it
// minted INV-0001 — and the insert SUCCEEDED, because the only unique index on
// invoices is invoices(job_id). Nothing in the schema or the app noticed. The
// owner ends up with two different invoices carrying the same number: the one
// identifier the customer, the receipt, the PDF and the books all key on.
// Verified against the live database: no unique index on invoices.invoice_number
// or quotes.quote_number, and production already carries two duplicated quote
// numbers. A number we could not verify is not a number.
H('Document numbers are never invented from a failed read')
{
  check('nextInvoiceNumber can report "I do not know"',
    // No dotAll flag: [^)] already spans newlines, and `s` fails `tsc` at this
    // target even though tsx accepts it — a green suite over a red build.
    /export async function nextInvoiceNumber\([^)]*\): Promise<string \| null>/.test(INVOICING), true)
  check('…because it inspects the error instead of coercing',
    /const \{ data, error \} = await supabase\.from\('invoices'\)\.select\('invoice_number'\)/.test(INVOICING)
    && /if \(error \|\| !data\) return null/.test(INVOICING), true)
  check('…and no longer coerces the row set with || []',
    /maxNumericSuffix\(\(\(data as \{ invoice_number: string \}\[\]\) \|\| \[\]\)/.test(INVOICING), false)

  // Every caller must REFUSE to create rather than write an unverified number.
  check('auto-draft refuses to draft without a verified number',
    /if \(!invoiceNumber\) return \{ created: false, reason: 'error' \}/.test(INVOICING), true)
  check('the manual New Invoice dialog refuses',
    /if \(!invoice_number\) throw new Error\(/.test(NEW_INVOICE), true)
  check('quote → invoice conversion refuses',
    /if \(!invoiceNumber\) \{/.test(QUOTE_DETAIL) && /was not converted/.test(QUOTE_DETAIL), true)

  // The refusal must come BEFORE the insert, not after it.
  const nMint = NEW_INVOICE.indexOf('if (!invoice_number)')
  const nInsert = NEW_INVOICE.indexOf(".from('invoices').insert(")
  check('…the dialog refuses before it inserts', nMint > 0 && nInsert > nMint, true)
  const qMint = QUOTE_DETAIL.indexOf('if (!invoiceNumber)')
  const qInsert = QUOTE_DETAIL.indexOf(".from('invoices').insert(")
  check('…conversion refuses before it inserts', qMint > 0 && qInsert > qMint, true)
}

H('Bulk quote actions refuse rather than renumber or double-bill')
{
  // The lie #1: a failed invoice_number read restarted the sequence at INV-0001.
  // The lie #2 (same statement): a failed read of which quotes ALREADY have an
  // invoice emptied `already`, so every selected quote was converted a second
  // time — the customer is billed twice for one job.
  check('bulk convert captures both read errors',
    /const \[\{ data: nums, error: numsErr \}, \{ data: existing, error: existingErr \}/.test(QUOTE_LIST), true)
  check('…and branches on them (naming an error is not checking it)',
    /if \(numsErr \|\| !nums \|\| existingErr \|\| !existing\) \{/.test(QUOTE_LIST), true)
  check('…converting nothing rather than billing twice',
    /nothing was converted/.test(QUOTE_LIST), true)

  // ⭐ THE QUOTE-NUMBER HALF OF THIS SECTION MOVED, AND GOT STRONGER (S123).
  // These used to assert that the browser CHECKED its quote_number read before
  // adding one to it. There is no read any more: the number comes from
  // public.allocate_quote_number() in one atomic statement, so the lie those
  // checks guarded against — "a failed read restarts the sequence at 0001" — is
  // now unreachable rather than merely handled. What still has to be true, and is
  // what these now assert, is that a FAILED ALLOCATION saves nothing.
  // (The invoice half above is untouched: src/lib/invoicing.ts still carries the
  // original read-then-mint shape, and belongs to another session.)
  check('bulk duplicate asks the database for its numbers',
    /allocateQuoteNumbers\(supabase, sel\.selectedItems\.length\)/.test(QUOTE_LIST), true)
  check('…and branches when allocation fails',
    /if \(alloc\.error \|\| !alloc\.quoteNumbers\) \{/.test(QUOTE_LIST), true)

  // The guard must sit between the read and the first mint in BOTH flows.
  const cGate = QUOTE_LIST.indexOf('if (numsErr || !nums || existingErr || !existing)')
  const cMint = QUOTE_LIST.indexOf("maxNumericSuffix((nums as { invoice_number: string }[])")
  check('…bulk convert gates before minting', cGate > 0 && cMint > cGate, true)
  const dGate = QUOTE_LIST.indexOf('if (alloc.error || !alloc.quoteNumbers)')
  const dUse = QUOTE_LIST.indexOf('quote_number: numbers[created]')
  check('…bulk duplicate gates before using a number', dGate > 0 && dUse > dGate, true)

  check('a new quote refuses to save under an unverified number',
    /if \(alloc\.error \|\| !alloc\.quoteNumber\) \{/.test(QUOTE_NEW)
    && /QUOTE_NUMBER_FAILED/.test(QUOTE_NEW), true)
  const nGate = QUOTE_NEW.indexOf('if (alloc.error || !alloc.quoteNumber)')
  const nUse = QUOTE_NEW.indexOf('const quote_number = alloc.quoteNumber')
  check('…before using one', nGate > 0 && nUse > nGate, true)
  // ⛔ AND THE STRONGER CLAIM THE NEW SHAPE MAKES POSSIBLE: there is no computed
  // fallback to fall back TO. A guessed document number is worse than no quote.
  check('…with no computed fallback anywhere in the seam',
    !/generateQuoteNumber/.test(read('src/lib/quoteNumber.ts')), true)
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE ADVISOR — "Nothing needs your attention", from a dropped connection
//
// The lie: eleven reads, every one coerced with `|| []`, not one error inspected.
// Total failure rendered a green check reading "Nothing needs your attention" at
// the top of Grow. The partial failures were worse, because the feed stayed
// plausible while the advice inverted:
//   • invoices fail → invoicedJobIds empties → completed work reads as UNBILLED,
//     so the advisor tells the owner to invoice already-invoiced jobs.
//   • quote_outcomes fail → priceLossRate falls to 0, DISABLING the "losing
//     mostly on price → never suggest a raise" suppression, so it recommends
//     raising prices at a business losing quotes on price.
H('The advisor says "couldn\'t check" instead of "all caught up"')
{
  check('loadSuggestions can report "I do not know"',
    /export async function loadSuggestions\([^)]*\): Promise<Suggestion\[\] \| null>/.test(SUGG_LOAD), true)
  check('…and an absent session is not an all-clear either',
    /if \(!user\) return null/.test(SUGG_LOAD), true)
  check('…with an explicit gate over the load-bearing reads',
    /jRes\.error \|\| qRes\.error \|\| rRes\.error \|\| pRes\.error \|\|[\s\S]{0,120}?cRes\.error \|\| iRes\.error \|\| liRes\.error \|\| woRes\.error \|\| sRes\.error/.test(SUGG_LOAD)
    && /if \(failed\) return null/.test(SUGG_LOAD), true)
  // The two reads that are allowed to fail quietly, and why. If a future change
  // makes neighbour leads or dismissals authoritative, this line should move.
  check('…while enrichment reads stay deliberately tolerant',
    /DELIBERATELY TOLERANT/.test(SUGG_LOAD) && /\|\| \[\]/.test(SUGG_LOAD), true)

  check('the feed tracks failure separately from emptiness',
    /const \[failed, setFailed\] = useState\(false\)/.test(SUGG_UI), true)
  check('…and does not cache an answer it never got',
    /if \(next == null\) \{ setFailed\(true\); return \}/.test(SUGG_UI), true)
  const nullGuard = SUGG_UI.indexOf('if (next == null)')
  const cacheWrite = SUGG_UI.indexOf("writeCache('suggestions', next)")
  check('…because writeCache sits AFTER the null guard', nullGuard > 0 && cacheWrite > nullGuard, true)
  check('the failed state says it is not an all-clear',
    /Couldn’t check your business/.test(SUGG_UI) && /not a clean bill of health/.test(SUGG_UI), true)
  check('…and offers a retry', /action=\{\{ label: 'Try again', onClick: load \}\}/.test(SUGG_UI), true)

  // The reassuring green state must still exist — for the case where it is TRUE.
  check('the genuine all-clear survives for a genuinely clean business',
    /tone="positive"[\s\S]{0,80}?title="Nothing needs your attention"/.test(SUGG_UI), true)
  // …but the failure branch must be evaluated FIRST, or the lie returns.
  const failBranch = SUGG_UI.indexOf('failed && items.length === 0')
  const okBranch = SUGG_UI.indexOf('title="Nothing needs your attention"')
  check('…and the failure branch is checked before it', failBranch > 0 && okBranch > failBranch, true)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. WHO TO CALL NEXT — a failed read scored the wrong people
//
// The lie: nine reads, all coerced. A failed customers/jobs read emptied the
// ranking ("nobody worth calling"); a failed INVOICES read emptied unpaidByCust,
// so a customer who owes money scored as one who "pays reliably — a great
// auto-pay candidate". That is precisely the mistake the deposit-awareness fix
// in this same file was written to prevent, reachable again via a blip.
// The page already had a correct "could not load — try again" state; the loader
// simply never returned null for it.
H('Revenue intelligence refuses to rank customers it could not read')
{
  check('the loader gates on every load-bearing read',
    /if \(jRes\.error \|\| qRes\.error \|\| rRes\.error \|\| pRes\.error \|\| cRes\.error \|\|[\s\S]{0,80}?iRes\.error \|\| liRes\.error \|\| sRes\.error \|\| fRes\.error\) return null/.test(REVINTEL), true)
  // The gate is worthless below the point where the report is assembled.
  const gate = REVINTEL.indexOf('if (jRes.error || qRes.error')
  const build = REVINTEL.indexOf('const report = computeRevenueIntel({')
  check('…before the report is computed', gate > 0 && build > gate, true)
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. REACTIVATION — "Every customer is booked or recently served"
//
// The lie: five reads, all coerced. A failed customers or jobs read produced
// "At risk: 0" over a green "Every customer is booked or recently served" — the
// most reassuring sentence in the app, invented from a network blip, on the one
// screen whose entire job is to warn that people are slipping away.
// Session 53 moved this gate off the page and into the loader (lib/reactivation
// loadReactivation), so the page can no longer coerce a failed read at all — it
// never sees one. The contract is unchanged and is pinned at its new home; the
// checks below must keep asserting BEHAVIOUR, never the old inline shape.
H('Reactivation does not invent an all-clear')
{
  const REACT_LIB = read('src/lib/reactivation.ts')
  check('the loader gates on all five reads',
    /const failed = \[cRes, jRes, qRes, rRes, sRes\]\.find\(r => r\.error\)/.test(REACT_LIB)
    && /if \(failed\?\.error\) return \{ ok: false/.test(REACT_LIB), true)
  check('…and an absent session is not an all-clear',
    /if \(!user\) return \{ ok: false/.test(REACT_LIB), true)
  check('the page has a failed state distinct from "nobody at risk"',
    /Couldn’t load the at-risk list/.test(REACT_PAGE), true)
  check('…which says it is not a sign that everyone is booked',
    /blank because we don’t know them, not because they’re zero/.test(REACT_PAGE), true)

  // The zeroed metric tiles are themselves a claim. There is no early return now:
  // every tile reads from `react`, which is null unless the load succeeded, so a
  // failed read paints an em dash. That is stronger than ordering — it cannot be
  // reordered into a lie.
  check('…and never paints "At risk: 0" from a failed read',
    /label="At risk" value=\{react \? String\(react\.atRisk\) : '—'\}/.test(REACT_PAGE), true)
  check('…and gates the positive empty state on a successful load',
    /\{react && risk\.length === 0 && ranOut\.length === 0 && \(!renew \|\| renew\.opportunities\.length === 0\) \?/.test(REACT_PAGE), true)
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE REFERENCE IMPLEMENTATIONS — do not let these rot
//
// The dashboard loader is the model the fixes above follow: read everything,
// then refuse ALL of it if any load-bearing read failed, rather than publish a
// partial morning. Pinned here because it is the pattern, not just a caller.
H('The established all-or-nothing loaders still hold')
{
  const DASH = read('src/lib/dashboard/data.ts')
  check('the dashboard still throws rather than render an unread figure',
    /if \(failure\) throw new Error\(`Dashboard could not load/.test(DASH), true)
  check('…including the comparison baselines',
    /prevWeekCash\.error \? `last week's payments/.test(DASH), true)

  const ACCT = read('src/lib/accounting/data.ts')
  const SHELL = read('src/components/accounting/ReportShell.tsx')
  check('accounting still collects per-read errors',
    /errors\.push\(/.test(ACCT), true)
  check('…and the report shell still shows them',
    /data\.errors\.length > 0/.test(SHELL), true)

  const LEDGER_PAGE = read('src/app/dashboard/payments/page.tsx')
  check('the payments ledger still refuses to render a failed read as "no payments"',
    /if \(pRes\.error\) \{ setLoadError\(/.test(LEDGER_PAGE), true)
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. DAY AVAILABILITY — an unknown day is never an open day
//
// The lie: `loadDayStatuses` did `data || []`, and an empty row set is a
// positive claim — "no day is blocked". Reproduced end to end before fixing:
// a day the owner marked Vacation went isDayBlocked=false, its capacity went
// from 0 back to a full 16 crew-hours, and Weather Ops named that exact day as
// the best place to move a rained-out day's work.
//
// This section runs the REAL functions against a Supabase double that fails the
// way the real client does (RESOLVES {data:null,error}, never throws), then pins
// the four states the fix has to keep straight: success, failed initial read,
// failed refresh, and an optimize attempt while availability is unknown.
H('Day availability: unknown is never open')
async function dayAvailability() {
  const { loadDayStatuses, buildDayStatusMap, isDayBlocked, buildCapacityForDate } =
    await import('../src/lib/dayStatus')
  const { computeWeatherImpact } = await import('../src/lib/weatherImpact')
  const { learnLaborModel } = await import('../src/lib/labor')

  const CLOSED = '2026-08-13'
  const ROWS = [{
    id: 'd1', date: CLOSED, status: 'vacation', blocks: true, label: null, notes: null,
    starts_at: null, ends_at: null, crew_size: null, created_by: null, created_at: '2026-08-01T00:00:00Z',
  }]
  const client = (res: unknown) => ({ from: () => ({ select: () => ({ eq: async () => res }) }) }) as never
  const OK = client({ data: ROWS, error: null })
  const DEAD = client({ data: null, error: { message: 'network error' } })

  // ── State 1: success ──
  const rows = await loadDayStatuses(OK, 'u1')
  check('success returns rows', Array.isArray(rows) && rows.length === 1, true)
  const map = buildDayStatusMap(rows ?? [])
  check('…the closed day is blocked', isDayBlocked(map, CLOSED), true)
  check('…and has zero capacity', buildCapacityForDate(map, { crew: 2, hours: 8 })(CLOSED), 0)

  // ── State 2: failed read is DISTINGUISHABLE from an empty schedule ──
  const dead = await loadDayStatuses(DEAD, 'u1')
  check('a failed read returns null, not []', dead, null)
  // The distinction that matters: [] is a real answer, null is the absence of one.
  const emptyButLoaded = await loadDayStatuses(client({ data: [], error: null }), 'u1')
  check('…while a genuinely empty schedule still returns []', Array.isArray(emptyButLoaded), true)

  // ── State 3: failed REFRESH keeps the last known map ──
  // The page does `if (rows) setDayStatusMap(...)`; simulate both halves here so
  // the contract is tested, not just the source text.
  let live = map
  const refreshed = await loadDayStatuses(DEAD, 'u1')
  if (refreshed) live = buildDayStatusMap(refreshed)
  check('a failed refresh does not erase the closed day', isDayBlocked(live, CLOSED), true)
  check('…and does not resurrect its capacity', buildCapacityForDate(live, { crew: 2, hours: 8 })(CLOSED), 0)

  // ── State 4: Weather Ops must not target a day it could not verify ──
  const forecast = [
    { date: '2026-08-12', rainy: true, mmRain: 14, popPct: 90, windKph: 20, code: 65, label: 'Heavy rain' },
    { date: CLOSED, rainy: false, mmRain: 0, popPct: 5, windKph: 8, code: 0, label: 'Clear' },
    { date: '2026-08-14', rainy: false, mmRain: 0, popPct: 5, windKph: 8, code: 0, label: 'Clear' },
  ] as never
  const jobs = [{ id: 'j1', date: '2026-08-12', sqft: 5000, serviceType: 'Lawn Mowing', crewSize: 2, propertyId: 'p1', isInitial: false, value: 120, customerId: 'c1' }] as never
  const model = learnLaborModel([])
  const days = [0, 1, 2, 3, 4, 5, 6]
  const wi = (ds: Parameters<typeof computeWeatherImpact>[8]) =>
    computeWeatherImpact(jobs, forecast, model, 16, days, '2026-08-12', 'x', false, ds)

  check('with a known map it skips the closed day', wi(map).atRiskDays[0]?.recommendedDay, '2026-08-14')
  // null = the read failed. Naming ANY day here is naming one we cannot verify.
  check('with UNKNOWN availability it names no day at all', wi(null).atRiskDays[0]?.recommendedDay, null)
  check('…and says why, rather than blaming the forecast',
    /Couldn’t load your closed days/.test(wi(null).atRiskDays[0]?.recommendedNote ?? ''), true)
  // The reassuring path must survive: a real, successfully-read empty schedule
  // still gets a recommendation. Refusing there would be its own bug.
  check('a loaded-but-empty schedule still gets a recommendation',
    wi(buildDayStatusMap([])).atRiskDays[0]?.recommendedDay, '2026-08-13')
}

// ── The wiring the engine tests above cannot see ──
function dayAvailabilityWiring() {
  const DS = read('src/lib/dayStatus.ts')
  const SCHED = read('src/app/dashboard/schedule/page.tsx')
  const WEATHER = read('src/lib/weatherImpact.ts')

  check('loadDayStatuses can report "I could not read"',
    /export async function loadDayStatuses\([^)]*\): Promise<DayStatusRow\[\] \| null>/.test(DS), true)
  check('…and the contract is written down where the next reader will be',
    /an UNKNOWN day is never an OPEN day/.test(DS), true)

  check('the schedule refresh keeps the last known map',
    /const rows = await loadDayStatuses\(supabase, user\.id\)\s*\r?\n\s*if \(rows\) setDayStatusMap\(buildDayStatusMap\(rows\)\)/.test(SCHED), true)
  check('…and no longer builds a map straight from the call',
    /setDayStatusMap\(buildDayStatusMap\(await loadDayStatuses/.test(SCHED), false)

  check('optimizing refuses while availability is unknown',
    /const dayStatusUnknown = dayStatusMap === undefined/.test(SCHED)
    && /if \(dayStatusUnknown\) \{ setBanner\(DAY_STATUS_UNKNOWN_MSG\); return \}/.test(SCHED), true)
  // The refusal must be INSIDE the single funnel both entry points use.
  const fnStart = SCHED.indexOf('function launchOptimizer(')
  const refusal = SCHED.indexOf('if (dayStatusUnknown) { setBanner(DAY_STATUS_UNKNOWN_MSG); return }', fnStart)
  const setsState = SCHED.indexOf('setShowOptimize(true)', fnStart)
  check('…before it opens the optimizer', fnStart > 0 && refusal > fnStart && setsState > refusal, true)
  check('auto-propose stays quiet instead of proposing a blind plan',
    /if \(dayStatusUnknown\) return/.test(SCHED), true)
  check('Reschedule refuses too — it picks destination days the same way',
    /if \(dayStatusUnknown\) \{ setBanner\(DAY_STATUS_UNKNOWN_MSG\); return \} setRainCenterDay/.test(SCHED), true)

  check('Weather Ops accepts "unknown" as a distinct input',
    /dayStatus: DayStatusMap \| null = \{ byDate: \{\}, blockedDates: new Set\(\) \}/.test(WEATHER), true)
  check('…its loader passes null when the read failed',
    /const dayStatus = dRes\.error \? null : buildDayStatusMap/.test(WEATHER), true)
  // ⭐ RE-POINTED, NOT RELAXED (Session 121). The search moved into
  // lib/weatherTruth so it could record WHY each day was passed over, and its
  // return type went from `string | null` to a result object — so the old
  // `return null` no longer appears. The CONTRACT is unchanged and is what is
  // asserted: with day availability UNKNOWN, it must refuse BEFORE scanning the
  // forecast, because every candidate is filtered by `blockedDates` and without
  // it the first dry day wins even if the owner had closed it.
  check('…and the dry-day search refuses before scanning the forecast',
    /if \(!dayStatusKnown\) return \{ chosen: null, chosenOverbooks: false, evaluations: \[\] \}/.test(WEATHER), true)
  // …and it refuses with an EMPTY explanation list, not a list of reasons it
  // never actually checked — an invented "why not" would be worse than silence.
  check('…returning no reasons either, since it examined no day',
    /evaluations: \[\] \}/.test(WEATHER), true)
}

// ═══════════════════════════════════════════════════════════════════════════
dayAvailability().then(() => {
  dayAvailabilityWiring()
  console.log(`\n${fail === 0 ? '✅' : '❌'} data-honesty: ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})
