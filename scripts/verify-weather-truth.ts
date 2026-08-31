// ── Verify: exactly one "Today", and a recommendation that explains itself ──
//   npm run verify:weather-truth
//
// TWO DEFECTS, ONE PAGE.
//
// ⭐⭐ 1. TWO CARDS BOTH SAID "TODAY". The page rendered its first card with a
// HARD-CODED label while the second computed its own from a DIFFERENT clock:
//
//     {r.today   && <WeatherCard f={r.today}    label="Today" />}
//     {r.tomorrow && <WeatherCard f={r.tomorrow} label={dayLabel(r.tomorrow.date, today)} />}
//
// `r.today` came from the impact engine, which used the DEVICE's local date;
// `today` came from the page, which used `new Date().toISOString().slice(0,10)`
// — UTC. Those disagree for the whole evening anywhere west of Greenwich. From
// ~17:00 in Alberta: card one held the 28th and said "Today" because the label
// was a constant, card two held the 29th and ALSO rendered "Today" because it
// equalled the UTC date. And the outlook strip marked "Now" by that same UTC
// comparison, so "Now" sat on tomorrow's column.
//
// ⭐⭐ 2. THE RECOMMENDATION CONTRADICTED THE FORECAST BESIDE IT. The dry-day
// search skipped days for five different reasons and reported one sentence:
// "No dry work day in range" — a claim about the FORECAST. The owner could see a
// sunny Saturday on the strip. The real reason was usually that Saturday is not
// one of their working days, which is a setting they can change in seconds and
// which nothing on the page ever mentioned.
//
// ⛔ These are tested as PROPERTIES, not as one reproduction. "At most one card
// says Today" has to hold for every pair of clocks, not just the pair that
// happened to break.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  forecastDayLabel, forecastDayFullLabel, countTodayLabels, findDryDay,
  explainableRejections, visiblyDryButRejected, rejectionLine, forecastHorizon,
  type DryDayInput,
} from '../src/lib/weatherTruth'
import { addDaysISO, tenantTodayISO } from '../src/lib/tenantTime'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
// Comments removed — every "must no longer appear" assertion reads this, because
// the fixes came with comments quoting the code they replaced. `[^\n\r]` not `.`:
// `.` does not match `\r`, and this repository checks out CRLF.
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/[^\n\r]*/g, '$1')

// ═══════════════════════════════════════════════════════════════════════════
// 1 · EXACTLY ONE "TODAY"
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ One day may call itself Today ═══')

const T = '2026-08-28'
const WEEK = Array.from({ length: 8 }, (_, i) => addDaysISO(T, i - 1))   // yesterday → +6

check('the tenant\'s today is labelled Today', forecastDayLabel(T, T).label === 'Today')
check('tomorrow says Tomorrow', forecastDayLabel(addDaysISO(T, 1), T).label === 'Tomorrow')
check('further out says the weekday', forecastDayLabel(addDaysISO(T, 3), T).label === 'Mon')
check('yesterday never says Today', forecastDayLabel(addDaysISO(T, -1), T).role === 'past')

// ⭐⭐ THE INVARIANT. Not "the bug is fixed" — "the bug is not expressible".
check('MUTATION — across a whole week, EXACTLY ONE day claims Today',
  countTodayLabels(WEEK, T) === 1, `${countTodayLabels(WEEK, T)} days claimed it`)
check('MUTATION — …and it still holds for every day of the year',
  Array.from({ length: 365 }, (_, i) => addDaysISO('2026-01-01', i))
    .every(d => countTodayLabels(WEEK, d) <= 1),
  'some tenant date made two of the same eight days claim Today')
check('a week that does not contain today claims it ZERO times',
  countTodayLabels(WEEK.map(d => addDaysISO(d, 30)), T) === 0)

{
  // ── MUTATION: the exact live failure, reconstructed ─────────────────────────
  // Card one is hard-labelled; card two compares against a clock that has already
  // rolled over. This is what the page did, and it produced two "Today"s.
  const engineToday = '2026-08-28'          // the device's date, at 23:30 local
  const pageToday = '2026-08-29'            // UTC, same instant
  const brokenLabels = [
    'Today',                                                    // hard-coded
    engineToday < pageToday ? 'Today' : 'Tomorrow',             // dayLabel(29th, 29th)
  ]
  check('MUTATION — the old two-clock rendering really did produce two "Today"s',
    brokenLabels.filter(l => l === 'Today').length === 2,
    'the fixture no longer reproduces the reported bug')
  // The same two cards, labelled the new way from ONE date, cannot.
  const fixed = [engineToday, addDaysISO(engineToday, 1)].map(d => forecastDayLabel(d, engineToday).label)
  check('…and labelling both from one tenant date yields exactly one',
    fixed.filter(l => l === 'Today').length === 1, fixed.join(' | '))
}

console.log('\n─── "Now" does not masquerade as another day ───')
// ⛔ "Now" is a statement about an INSTANT inside today. Attaching it to a DAY is
// what let it drift onto tomorrow's column when the comparison used UTC.
check('MUTATION — no day label is ever the word "Now"',
  WEEK.every(d => forecastDayLabel(d, T).short !== 'Now' && forecastDayLabel(d, T).label !== 'Now'))
check('…the current day\'s strip column says Today', forecastDayLabel(T, T).short === 'Today')
check('…and every other column says its weekday',
  forecastDayLabel(addDaysISO(T, 2), T).short === 'Sun')
{
  const page = code('src/app/dashboard/weather/page.tsx')
  check('MUTATION — the page no longer renders a bare "Now"', !/'Now'/.test(page) && !/>Now</.test(page))
  check('MUTATION — …and no card is handed a label to print',
    !/label="Today"/.test(page) && !/label=\{/.test(page),
    'a card that can be TOLD what day it is can be told the wrong one')
  check('every card asks the one engine for its own words',
    /forecastDayLabel\(/.test(page) && /todayISO=\{today\}/.test(page))
}

console.log('\n─── Future cards carry a real date ───')
// ⚠️ "Fri" alone is indistinguishable from NEXT Friday, on the strip an owner
// uses to decide which day to move a rained-out job to.
check('every day label can produce its calendar date',
  WEEK.every(d => /^[A-Z][a-z]{2} \d{1,2}$/.test(forecastDayLabel(d, T).dated)))
check('the full label pairs the relative word with the date',
  forecastDayFullLabel(T, T) === 'Today · Aug 28'
  && forecastDayFullLabel(addDaysISO(T, 1), T) === 'Tomorrow · Aug 29'
  && forecastDayFullLabel(addDaysISO(T, 4), T) === 'Tue Sep 1')
check('…including across a month end', forecastDayFullLabel('2026-09-01', '2026-08-31') === 'Tomorrow · Sep 1')
{
  const page = code('src/app/dashboard/weather/page.tsx')
  check('the strip prints the date under every column', /forecastDayLabel\(f\.date, today\)\.dated/.test(page))
  check('the two day cards print theirs too', /\{d\.dated\}/.test(page))
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE RECOMMENDATION EXPLAINS ITSELF
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Why a dry day was not recommended ═══')

// Mon 31 Aug → Sun 6 Sep. Rain on Tue; the owner works Mon–Fri; Thu is blocked;
// Wed is full. So the only day the search can take is Friday — and Saturday is
// dry, visible, and rejected for a reason that is nothing to do with weather.
const DAYS = [
  { date: '2026-08-31', rainy: false },  // Mon — before the moved day
  { date: '2026-09-01', rainy: true },   // Tue — the rained-out day
  { date: '2026-09-02', rainy: false },  // Wed — dry but full
  { date: '2026-09-03', rainy: false },  // Thu — dry but blocked
  { date: '2026-09-04', rainy: false },  // Fri — dry, open, room
  { date: '2026-09-05', rainy: false },  // Sat — dry, but not a working day
  { date: '2026-09-06', rainy: false },  // Sun — dry, but not a working day
]
const INPUT: DryDayInput = {
  days: DAYS, afterDate: '2026-09-01', neededHours: 4,
  hoursByDate: { '2026-09-02': 7 },
  capacityHours: 8,
  preferredDays: new Set([1, 2, 3, 4, 5]),   // Mon–Fri
  blockedDates: new Set(['2026-09-03']),
}
const search = findDryDay(INPUT)

check('it picks the first working, dry, roomy day', search.chosen === '2026-09-04', String(search.chosen))
check('…and does not claim it overbooks', search.chosenOverbooks === false)
const byDate = Object.fromEntries(search.evaluations.map(e => [e.date, e.rejection]))
check('Monday was passed over as before the moved day', byDate['2026-08-31'] === 'not_after')
check('Wednesday was passed over as ALREADY FULL — not as rainy',
  byDate['2026-09-02'] === 'over_capacity')
check('Thursday was passed over as blocked by the owner', byDate['2026-09-03'] === 'day_blocked')
check('Friday was ACCEPTED', byDate['2026-09-04'] === null)

// ⭐⭐ THE CONTRADICTION TEST. Saturday is visibly dry on the strip and was not
// recommended. Before this the page said nothing at all about that.
const dryRejected = visiblyDryButRejected(search)
check('MUTATION — a visibly DRY day that was rejected is reported, with its reason',
  dryRejected.some(e => e.date === '2026-09-02' && e.rejection === 'over_capacity')
  && dryRejected.some(e => e.date === '2026-09-03' && e.rejection === 'day_blocked'),
  JSON.stringify(dryRejected))
// Saturday/Sunday were never evaluated here because Friday won and the loop
// stopped — which is correct and is not a contradiction: the recommendation
// names an EARLIER day than the one the owner is wondering about.
check('…and the search stops once it has an answer, rather than scoring the week',
  !search.evaluations.some(e => e.date === '2026-09-06'))

console.log('\n─── The rejection nobody can act on is not the headline ───')
// ⭐ "Monday was rejected because it is before Tuesday" is noise, and burying the
// two reasons an owner CAN act on underneath it is how an explanation stops
// being read.
const explainable = explainableRejections(search)
check('MUTATION — "before the moved day" is never shown',
  !explainable.some(e => e.rejection === 'not_after'))
check('the actionable reasons come first',
  explainable[0]?.rejection === 'over_capacity' || explainable[0]?.rejection === 'not_a_work_day',
  explainable.map(e => e.rejection).join(', '))
check('a rejection reads as a sentence, with the day named and dated',
  rejectionLine({ date: '2026-09-05', rejection: 'not_a_work_day' }, '2026-09-01')
    === 'Sat Sep 5 — not one of your working days')
// ⚠️ Anchored three days back on purpose. Against 2026-09-01 the 2nd is
// TOMORROW, and the line correctly reads "Tomorrow · Sep 2" — which is the
// relative labelling working, not a formatting bug. Pinning the weekday form
// needs a date far enough out to have one.
check('…and carries its detail when there is one',
  rejectionLine({ date: '2026-09-02', rejection: 'over_capacity', detail: '11h of 8h' }, '2026-08-30')
    === 'Wed Sep 2 — already full (11h of 8h)',
  rejectionLine({ date: '2026-09-02', rejection: 'over_capacity', detail: '11h of 8h' }, '2026-08-30'))
check('…and uses the relative word when the day is near',
  rejectionLine({ date: '2026-09-02', rejection: 'day_blocked' }, '2026-09-01')
    === 'Tomorrow · Sep 2 — you marked this day unavailable')

console.log('\n─── The working-days case, which was the commonest one ───')
{
  // Same week, but the only dry days left are the weekend.
  const weekendOnly = findDryDay({
    ...INPUT,
    days: DAYS.map(d => ({ ...d, rainy: d.date >= '2026-09-01' && d.date <= '2026-09-04' })),
  })
  check('nothing is recommended when every working day is out', weekendOnly.chosen === null)
  const why = visiblyDryButRejected(weekendOnly)
  // ⛔ THE OLD SENTENCE — "No dry work day in range" — was a claim about the
  // FORECAST, and the owner could see two sunny days on the strip. The truthful
  // answer is about their working-days setting.
  check('MUTATION — the weekend is reported as NOT A WORKING DAY, not as rain',
    why.some(e => e.date === '2026-09-05' && e.rejection === 'not_a_work_day')
    && why.some(e => e.date === '2026-09-06' && e.rejection === 'not_a_work_day'),
    JSON.stringify(why))
  check('…and no dry day is ever mislabelled rainy',
    !why.some(e => e.rejection === 'rainy'))
}
{
  // With no working-day preference set, every day qualifies — the weekend is
  // recommended rather than silently skipped.
  // Wednesday is still FULL (7h booked + 4h needed > 8h capacity), so the first
  // day with room is Thursday — which was only unavailable because the owner had
  // blocked it. Clearing the block genuinely changes the answer, and that is the
  // point of the case: the rejection reasons are real inputs, not decoration.
  const noPref = findDryDay({ ...INPUT, preferredDays: null, blockedDates: new Set() })
  check('clearing a block genuinely opens that day up', noPref.chosen === '2026-09-03', String(noPref.chosen))
  // And with the weekend allowed AND Thursday still blocked, Friday wins — the
  // preference was never what stood in Friday's way.
  const weekendOk = findDryDay({ ...INPUT, preferredDays: null })
  check('…while an unrestricted week still respects capacity and blocks',
    weekendOk.chosen === '2026-09-04', String(weekendOk.chosen))
}
{
  // Everything full → fall back to the soonest dry day and SAY it overbooks.
  const allFull = findDryDay({ ...INPUT, capacityHours: 1, blockedDates: new Set() })
  check('when nothing has room, the soonest dry day is named AND flagged',
    allFull.chosen === '2026-09-02' && allFull.chosenOverbooks === true,
    `${allFull.chosen} overbooks=${allFull.chosenOverbooks}`)
}
{
  // Rain-only rejections contradict nothing — the strip already shows the rain.
  const rainOnly = findDryDay({
    ...INPUT, preferredDays: null, blockedDates: new Set(),
    days: DAYS.map(d => ({ ...d, rainy: true })),
  })
  check('MUTATION — a week of rain produces NO "why not" list to explain',
    visiblyDryButRejected(rainOnly).length === 0,
    'listing rainy days as unexplained rejections is noise, not an explanation')
}

console.log('\n─── The page shows the reasons ───')
{
  const page = code('src/app/dashboard/weather/page.tsx')
  check('the page renders the rejections', /d\.rejections/.test(page) && /rejectionLine\(/.test(page))
  check('…under a question the owner would actually ask',
    /Why not the other dry days\?/.test(read('src/app/dashboard/weather/page.tsx')))
  check('…and says where the settings behind them live',
    /Working days and daily capacity come from Settings/.test(read('src/app/dashboard/weather/page.tsx')))
  const engine = code('src/lib/weatherImpact.ts')
  check('the engine carries them off the search rather than re-deriving',
    /visiblyDryButRejected\(search\)/.test(engine))
  check('…and the old reason-losing search is gone',
    !/const findDryDay = \(afterDate/.test(engine),
    'the local search that discarded its reasons is still here')
}

console.log('\n─── The forecast window is the tenant\'s ───')
check('the horizon is calendar arithmetic from the tenant date',
  forecastHorizon('2026-02-26', 8) === '2026-03-06')
check('…and crosses a DST boundary without drifting',
  forecastHorizon('2026-03-05', 8) === '2026-03-13')
check('…and is the same eight days wherever the server is',
  forecastHorizon(tenantTodayISO('America/Edmonton', new Date('2026-08-29T05:30:00Z')), 8) === '2026-09-05')

console.log(failures === 0
  ? '\n✅ weather truth: every check passed\n'
  : `\n❌ weather truth: ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
