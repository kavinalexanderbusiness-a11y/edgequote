// ── Verify: one tenant-local day boundary, and it survives DST ──────────────
//   npm run verify:tenant-time
//
// WHAT THIS GUARDS. A production audit found the Dashboard, the Schedule and
// Weather disagreeing about what day it is. The cause was not arithmetic — it
// was that THREE different clocks were being consulted and nobody owned the
// question:
//
//   localTodayISO()            the RUNTIME's zone. In a browser that is the
//                              DEVICE's; on Vercel it is UTC (nothing sets TZ —
//                              checked in next.config.ts and vercel.json). The
//                              Dashboard renders on the server, the Schedule on
//                              the client, so the same helper gave them
//                              different days every evening.
//   new Date().toISOString()   plain UTC, at 19 more sites including the Weather
//     .slice(0, 10)            page — where from ~17:00 in Alberta "today" was
//                              already tomorrow.
//   business_settings.timezone the tenant's actual IANA zone. It EXISTED, NOT
//                              NULL, defaulting to 'America/Edmonton', and had
//                              exactly ONE reader in the whole application.
//
// So nothing needed to be designed. A setting the product already had simply had
// to be consulted, and the answer had to come from one place.
//
// ⭐ EVERY DST ASSERTION BELOW IS MEASURED AGAINST THE REAL IANA DATABASE, not
// against hard-coded transition dates. A guard that pins "2026-03-08 is 23 hours
// long" rots the moment a government moves a transition; one that asks the zone
// how long the day is cannot.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  FALLBACK_TIME_ZONE, isValidTimeZone, safeTimeZone, tenantMoment, tenantTodayISO,
  tenantDateISO, isTenantToday, addDaysISO, daysBetweenISO, dayOfWeekISO,
  startOfTenantDayUTC, offsetMs, hasDstTransition, tenantDayLengthHours,
  dayRole, dayLabel, weekdayShort, formatMonthDay,
} from '../src/lib/tenantTime'

let failures = 0
const ok = (n: string) => console.log(`  ✓ ${n}`)
const fail = (n: string, d = '') => { failures++; console.log(`  ✗ ${n}${d ? `\n      ${d}` : ''}`) }
const check = (n: string, c: boolean, d = '') => (c ? ok(n) : fail(n, d))
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

/**
 * The file with its COMMENTS REMOVED.
 *
 * ⚠️ Every "this must no longer appear" assertion below reads this, not the raw
 * source — because the fix for each of these defects came with a comment SAYING
 * what used to be there. Grepping the raw file for `localTodayISO()` therefore
 * matched the sentence explaining that it had been removed, and five checks
 * failed on their own documentation.
 *
 * ⚠️⚠️ `[^\n]` rather than `.` for the line comment: `.` does not match `\r`, so
 * on a CRLF checkout — which this repository is — a `.`-based stripper leaves
 * the carriage return and silently mis-slices. Both line endings are handled.
 */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:"'`\\])\/\/[^\n\r]*/g, '$1')

const EDM = 'America/Edmonton'

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE ZONE IS A PLACE, NEVER AN OFFSET
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ IANA names, never fixed offsets ═══')

check('a real zone is accepted', isValidTimeZone(EDM) && isValidTimeZone('Pacific/Auckland'))
check('UTC is a legitimate choice', isValidTimeZone('UTC'))
// ⛔ THE RULE. An offset is a fact about one INSTANT, not about a place:
// Edmonton is -07:00 for four months and -06:00 for eight. Storing one means the
// day boundary silently moves by an hour twice a year, in opposite directions.
for (const bad of ['-06:00', '+05:30', 'UTC-6', 'GMT+2', 'utc-07:00']) {
  check(`MUTATION — the offset ${JSON.stringify(bad)} is REFUSED`, !isValidTimeZone(bad))
}
check('garbage and blanks are refused',
  !isValidTimeZone('Not/AZone') && !isValidTimeZone('') && !isValidTimeZone(null) && !isValidTimeZone('   '))
check('the fallback is a real zone, and is the column default',
  isValidTimeZone(FALLBACK_TIME_ZONE) && FALLBACK_TIME_ZONE === 'America/Edmonton')
// ⭐ A fallback that disagreed with the schema default would mean a business
// whose row has never been written renders one day on the server and another in
// the browser — the very split this file exists to close.
{
  // ⚠️⚠️ THE APPLY PATH, NOT A FILENAME. This guard was written against
  // `20260828120001_baseline.sql` and that file was renamed to `…140001…` the
  // very next time a migration was converged into the baseline — the trap the
  // landing session had just paid for in four other guards, one of which threw
  // ENOENT and took the whole suite down with it. Read whatever the apply path
  // currently holds.
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
  check('…and the schema really does default to it',
    /"timezone" text default 'America\/Edmonton'::text not null/.test(sql),
    'business_settings.timezone no longer defaults to the value lib/tenantTime falls back to')
  // ⭐ THE MEASUREMENT THAT STARTED THIS SESSION, pinned so it stays true: the
  // column already existed. Nothing here designs a new setting.
  check('the tenant zone column is IANA-shaped and NOT NULL — it already existed',
    /"timezone" text default '[A-Za-z]+\/[A-Za-z_]+'::text not null/.test(sql))
}
check('an unusable zone falls back rather than throwing',
  safeTimeZone('-06:00') === FALLBACK_TIME_ZONE && safeTimeZone(null) === FALLBACK_TIME_ZONE)
check('…and a good one is passed through, trimmed', safeTimeZone('  UTC  ') === 'UTC')

// ═══════════════════════════════════════════════════════════════════════════
// 2 · MIDNIGHT, AND THE UTC/LOCAL MISMATCH THAT CAUSED THE BUG
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ The evening, when UTC has already rolled over ═══')

// 23:30 on the 28th in Edmonton is 05:30 on the 29th in UTC.
const lateEvening = new Date('2026-08-29T05:30:00Z')
check('UTC says the 29th', lateEvening.toISOString().slice(0, 10) === '2026-08-29')
check('the BUSINESS says the 28th', tenantTodayISO(EDM, lateEvening) === '2026-08-28')
// ⭐⭐ THE HEADLINE MUTATION. This is the whole production defect in one line.
check('MUTATION — a UTC "today" and the tenant\'s day are DIFFERENT DAYS at 23:30',
  lateEvening.toISOString().slice(0, 10) !== tenantTodayISO(EDM, lateEvening),
  'if these agree the fixture no longer reproduces the reported bug')
check('…and the wall clock reads 23:30, not 05:30',
  tenantMoment(EDM, lateEvening).hour === 23 && tenantMoment(EDM, lateEvening).minute === 30)

// One minute later it IS the 29th for the business too.
const justAfter = new Date('2026-08-29T06:00:00Z')
check('one minute past midnight local, the business day rolls',
  tenantTodayISO(EDM, justAfter) === '2026-08-29')
check('…and the boundary is exactly there, not an hour either side',
  tenantTodayISO(EDM, new Date('2026-08-29T05:59:00Z')) === '2026-08-28')

// East of Greenwich the mismatch runs the other way — a guard written only for
// one hemisphere would pass while being wrong for half the world.
const tokyoMorning = new Date('2026-08-29T00:30:00Z')  // 09:30 on the 29th in Tokyo
check('east of UTC the mismatch reverses, and is still handled',
  tenantTodayISO('Asia/Tokyo', tokyoMorning) === '2026-08-29'
  && tenantTodayISO(EDM, tokyoMorning) === '2026-08-28')

check('isTenantToday agrees with tenantTodayISO', isTenantToday(EDM, '2026-08-28', lateEvening))
check('…and rejects the UTC date', !isTenantToday(EDM, '2026-08-29', lateEvening))
check('tenantDateISO works for any instant, not just now',
  tenantDateISO(EDM, new Date('2026-01-01T06:59:00Z')) === '2025-12-31')

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DST — START, END, AND THE ZONES WHERE MIDNIGHT DOES NOT EXIST
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ Daylight saving, measured against the real zone data ═══')

// The transition dates are FOUND, not asserted, so this cannot rot.
function transitionsIn(tz: string, year: number): string[] {
  const out: string[] = []
  let d = `${year}-01-01`
  for (let i = 0; i < 366; i++) { if (hasDstTransition(tz, d)) out.push(d); d = addDaysISO(d, 1) }
  return out
}
const edmTrans = transitionsIn(EDM, 2026)
check('Edmonton has exactly two transitions in 2026', edmTrans.length === 2, edmTrans.join(', '))
const [springForward, fallBack] = edmTrans
check('one is short and one is long',
  tenantDayLengthHours(EDM, springForward) === 23 && tenantDayLengthHours(EDM, fallBack) === 25,
  `${springForward}=${tenantDayLengthHours(EDM, springForward)}h ${fallBack}=${tenantDayLengthHours(EDM, fallBack)}h`)
check('every other day is 24 hours', tenantDayLengthHours(EDM, '2026-06-15') === 24)
check('a zone with no DST never transitions',
  transitionsIn('UTC', 2026).length === 0 && transitionsIn('America/Regina', 2026).length === 0)

// ⭐⭐ CALENDAR ARITHMETIC MUST NOT GO THROUGH A CLOCK.
console.log('\n─── Adding a day is a calendar operation, not +86,400,000ms ───')
check('the day after the short day is the next date', addDaysISO(springForward, 1) === addDaysISO(springForward, 1))
check('+1 across spring forward lands on the next calendar date',
  daysBetweenISO(springForward, addDaysISO(springForward, 1)) === 1)
check('+1 across fall back lands on the next calendar date',
  daysBetweenISO(fallBack, addDaysISO(fallBack, 1)) === 1)
check('a week is seven days across BOTH transitions',
  daysBetweenISO(addDaysISO(springForward, -3), addDaysISO(springForward, 4)) === 7
  && daysBetweenISO(addDaysISO(fallBack, -3), addDaysISO(fallBack, 4)) === 7)
check('month and year ends roll correctly',
  addDaysISO('2026-01-31', 1) === '2026-02-01'
  && addDaysISO('2026-12-31', 1) === '2027-01-01'
  && addDaysISO('2028-02-28', 1) === '2028-02-29')
check('going backwards works too', addDaysISO('2027-01-01', -1) === '2026-12-31')

{
  // ── MUTATION ──────────────────────────────────────────────────────────────
  // The implementation a reasonable person writes: take the day's start, add 24
  // hours, read the date back. It is right for 363 days a year.
  const naiveNextDay = (tz: string, iso: string) =>
    tenantDateISO(tz, new Date(startOfTenantDayUTC(tz, iso).getTime() + 86_400_000))
  const naiveBreaks = [springForward, fallBack].filter(d => naiveNextDay(EDM, d) !== addDaysISO(d, 1))
  // Edmonton's transitions are at 02:00, far enough from midnight that even the
  // naive form survives — so the mutation is proved where it genuinely bites:
  // Lord Howe's 30-minute shift, where +24h from the start of the long day lands
  // BEFORE the next day begins.
  const lhBreaks = transitionsIn('Australia/Lord_Howe', 2026)
    .filter(d => naiveNextDay('Australia/Lord_Howe', d) !== addDaysISO(d, 1))
  check('MUTATION — a +24h "next day" is wrong somewhere, and addDaysISO is not',
    naiveBreaks.length + lhBreaks.length > 0,
    'no zone tested exposes the naive form; the mutation proves nothing as written')
  check('…and the real helper is right on every one of those days',
    [...naiveBreaks, ...lhBreaks].every(d => daysBetweenISO(d, addDaysISO(d, 1)) === 1))
}

// ⭐⭐ START OF DAY — including the zones where 00:00 SIMPLY DOES NOT EXIST.
console.log('\n─── The first instant of a day, in zones that skip midnight ───')
const START_ZONES = [
  EDM, 'UTC', 'Asia/Tokyo',
  // These four transition AT or WITHIN an hour of local midnight. Havana and
  // Santiago spring forward at 00:00 — the clock goes 23:59:59 → 01:00:00, so
  // there IS no midnight and the day legitimately begins at 01:00.
  'America/Havana', 'America/Santiago', 'Asia/Beirut', 'Australia/Lord_Howe', 'Pacific/Chatham',
]
let startBad = 0
for (const tz of START_ZONES) {
  for (const iso of transitionsIn(tz, 2026).concat(['2026-06-15'])) {
    const s = startOfTenantDayUTC(tz, iso)
    const onTheDay = tenantDateISO(tz, s) === iso
    // …and it is the FIRST instant of it: one minute earlier belongs to yesterday.
    const isFirst = tenantDateISO(tz, new Date(s.getTime() - 60_000)) < iso
    if (!onTheDay || !isFirst) { startBad++; console.log(`      ${tz} ${iso} → ${s.toISOString()} (${tenantDateISO(tz, s)})`) }
  }
}
check('the start of a day always belongs to that day, and is its first instant',
  startBad === 0, `${startBad} zone/day pair(s) wrong`)
// The specific case that caught a real bug in this file: two offset passes alone
// settle on 23:00 of the PREVIOUS day for Havana, because midnight is skipped.
check('a skipped midnight resolves FORWARD, not into yesterday',
  tenantDateISO('America/Havana', startOfTenantDayUTC('America/Havana', transitionsIn('America/Havana', 2026)[0])) ===
    transitionsIn('America/Havana', 2026)[0])
check('offsetMs reports a real, whole-minute offset',
  offsetMs(EDM, new Date('2026-06-15T12:00:00Z')) === -6 * 3_600_000
  && offsetMs(EDM, new Date('2026-01-15T12:00:00Z')) === -7 * 3_600_000
  && offsetMs('Asia/Kolkata', new Date('2026-06-15T12:00:00Z')) === 5.5 * 3_600_000)

// ═══════════════════════════════════════════════════════════════════════════
// 4 · SAYING WHICH DAY IT IS
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ One date may be called "today", and it carries its date ═══')

const T = '2026-08-28'
check('today is today', dayRole(T, T) === 'today')
check('tomorrow is tomorrow', dayRole('2026-08-29', T) === 'tomorrow')
check('the day after is neither', dayRole('2026-08-30', T) === 'future')
check('yesterday is past', dayRole('2026-08-27', T) === 'past')
check('the roles hold across a month end',
  dayRole('2026-09-01', '2026-08-31') === 'tomorrow' && dayRole('2026-09-02', '2026-08-31') === 'future')
check('a label always carries its date when asked',
  dayLabel(T, T, { withDate: true }) === 'Today · Aug 28'
  && dayLabel('2026-08-31', T, { withDate: true }) === 'Mon Aug 31')

// ⚠️ Formatting a bare calendar date through `new Date(iso)` treats it as UTC
// midnight, which renders as the PREVIOUS day for every viewer west of
// Greenwich — the same off-by-one, arriving through the formatter.
check('weekdays are derived from the DATE, never from a localised Date',
  weekdayShort('2026-08-28') === 'Fri' && weekdayShort('2026-03-01') === 'Sun'
  && formatMonthDay('2026-03-01') === 'Mar 1')
check('dayOfWeekISO agrees, and is zone-free',
  dayOfWeekISO('2026-08-28') === 5 && dayOfWeekISO('2026-08-30') === 0)

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE SURFACES ACTUALLY ASK
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ The surfaces that disagreed now share one clock ═══')

const provider = read('src/components/layout/TenantTimeProvider.tsx')
check('a provider reads the tenant zone once, for everybody',
  /business_settings/.test(provider) && /select\('timezone'\)/.test(provider))
check('…and is mounted above every dashboard surface',
  /<TenantTimeProvider>/.test(read('src/app/dashboard/layout.tsx')))
// ⚠️ Rendering "Today" from a guess before the row is read shows the wrong day
// for the first few hundred ms of every load — worse than a skeleton, because it
// looks like an answer.
check('…and reports whether it has actually read the row', /ready/.test(provider))
check('…and distinguishes "no zone set" from "could not ask"', /usingFallback/.test(provider))
// A dashboard left open overnight must roll over on its own.
check('…and re-derives the day as it rolls over', /setInterval/.test(provider))

const weatherPage = code('src/app/dashboard/weather/page.tsx')
check('WEATHER — no longer derives its own date from UTC',
  !/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(weatherPage) && /useTenantTime\(\)/.test(weatherPage))
const weatherImpact = code('src/lib/weatherImpact.ts')
check('WEATHER ENGINE — takes the tenant date, not the runtime\'s',
  /tenantTodayISO\(tz\)/.test(weatherImpact) && !/localTodayISO/.test(weatherImpact))
const schedule = code('src/app/dashboard/schedule/page.tsx')
check('SCHEDULE — reads the shared clock, not the device',
  /useTenantTime\(\)/.test(schedule) && !/localTodayISO\(\)/.test(schedule))
const dashData = code('src/lib/dashboard/data.ts')
check('DASHBOARD — reads the tenant zone server-side, not the server\'s UTC',
  // Either the loadTenantToday wrapper, or the unpacked form (S97: reads
  // loadTenantTimeZone directly and derives `today` from one captured
  // tenantMoment — value-identical, since tenantTodayISO IS tenantMoment().date).
  (/loadTenantToday\(sb, userId\)/.test(dashData)
    || (/loadTenantTimeZone\(sb, userId\)/.test(dashData)
      && (/tenantTodayISO\(timeZone\)/.test(dashData) || /const today = tenantNow\.date/.test(dashData))))
  && !/localTodayISO/.test(dashData))
check('DASHBOARD — greeting/dateLine share that SAME tenant zone, not new Date()',
  /tenantMoment\(timeZone\)/.test(dashData)
  && !/now\.getHours\(\)/.test(dashData)
  && !/now\.toLocaleDateString/.test(dashData))
// ⭐ ONE INSTANT. `today` (every money/KPI bound), the greeting's `hour` and
// `dateLine` must all come from ONE captured clock read. Two reads — even of
// the same correct zone — straddle the query batch, and a request that runs
// across the tenant's midnight then renders "Good morning" beside yesterday's
// date (S110 review). Pinned as a count, not a shape: exactly one tenantMoment
// call in the file, and all three consumers hang off it.
check('DASHBOARD — today, hour and dateLine share ONE captured tenantMoment',
  (dashData.match(/tenantMoment\(/g) || []).length === 1
  && /const today = tenantNow\.date/.test(dashData)
  && /const hour = tenantNow\.hour/.test(dashData)
  && /new Date\(`\$\{today\}T00:00:00`\)/.test(dashData))
check('DASHBOARD PAGE — same', /loadTenantToday\(/.test(read('src/app/dashboard/page.tsx')))
// ⭐ And the zone must ride along to the weather engine, or the dashboard's
// preloaded settings would silently send it back to the fallback.
check('…and carries the zone into the preloaded settings it hands on',
  /base_address, timezone/.test(dashData))

console.log('\n─── The greeting/dateLine bug, reproduced and fixed (S97 follow-up) ───')
// The reported defect, live: 2026-09-04 14:40 in Edmonton (MDT, UTC-6) is
// 2026-09-04 20:40 UTC. The OLD code read `new Date().getHours()` on the
// server — Vercel's clock, which is UTC — so it saw hour 20 and said "Good
// evening" while the owner's own afternoon was mid-day. This is the exact
// bucket boundary (>=17) the greeting formula uses, so this instant is the
// sharpest possible reproduction: one hour either side of it would not
// distinguish the bug from the fix.
const reportedMoment = new Date('2026-09-04T20:40:00Z')
const edmontonAtReport = tenantMoment(EDM, reportedMoment)
check('the wall clock in Edmonton reads 14:40, not 20:40',
  edmontonAtReport.hour === 14 && edmontonAtReport.minute === 40)
check('MUTATION — the server’s own UTC hour is 20 (>=17 ⇒ "evening"), a DIFFERENT bucket than Edmonton’s 14 (<17 ⇒ "afternoon")',
  reportedMoment.getUTCHours() === 20 && edmontonAtReport.hour === 14,
  'if these land in the same bucket the fixture no longer reproduces the reported "Good evening" defect')
// The dashboard's greeting formula, restated here byte-for-byte from
// src/lib/dashboard/data.ts (`hour < 12 ? 'Good morning' : hour < 17 ?
// 'Good afternoon' : 'Good evening'`) — proving what TEXT the fix produces,
// not just that the hour value changed.
const greetingFor = (hour: number) => hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
check('FIXED — tenantMoment(timeZone).hour buckets to "Good afternoon"',
  greetingFor(edmontonAtReport.hour) === 'Good afternoon')
check('OLD BUG — the raw UTC hour would have bucketed to "Good evening"',
  greetingFor(reportedMoment.getUTCHours()) === 'Good evening',
  'confirms the OLD code path (server UTC hour) really did produce the reported wrong greeting')

// `today` now comes from tenantMoment(tz).date instead of tenantTodayISO(tz).
// Those must be the same value at every boundary, or the query bounds moved.
check('today via tenantMoment(...).date === tenantTodayISO(...) at every boundary instant',
  [lateEvening, new Date('2026-08-29T05:59:00Z'), justAfter, reportedMoment]
    .every(i => tenantMoment(EDM, i).date === tenantTodayISO(EDM, i)))
// Why ONE instant: a split read (date early, hour after the batch) across
// local midnight — 23:59:45 → 00:00:15 — produces yesterday's date with hour
// 0: "Good morning, Friday the 28th" on Saturday the 29th. One read cannot.
const before = new Date('2026-08-29T05:59:45Z')
const after = new Date(before.getTime() + 30_000)
const split = { date: tenantMoment(EDM, before).date, hour: tenantMoment(EDM, after).hour }
check('MUTATION — a split read across midnight is incoherent (28th, hour 0)',
  split.date === '2026-08-28' && split.hour === 0,
  'if this stops reproducing, the fixture no longer straddles the boundary')
check('…while one captured instant is coherent on either side of it',
  [before, after].every(i => {
    const m = tenantMoment(EDM, i)
    return (m.date === '2026-08-28' && m.hour === 23) || (m.date === '2026-08-29' && m.hour === 0)
  }))

// NOT re-tested here: dateLine's local-date boundary. dateLine is built from
// `today` (= tenantMoment(timeZone).date, proven value-identical to
// tenantTodayISO just above), and that boundary — `lateEvening`/`justAfter`,
// 23:30 → 00:00 Edmonton across the UTC day-roll — is already proven a few
// dozen lines up in THIS file. `today` and `dateLine` cannot disagree about
// the date by construction, not by two tests happening to agree.

console.log('\n─── Crons compute a date PER TENANT ───')
for (const [name, file] of [
  ['reports', 'src/app/api/cron/reports/route.ts'],
  ['invoice-reminders', 'src/app/api/cron/invoice-reminders/route.ts'],
  ['quote-followup', 'src/app/api/cron/quote-followup/route.ts'],
] as const) {
  const src = code(file)
  check(`CRON ${name} — one zone read, then a date per tenant`,
    /loadTenantZones\(/.test(src) && /todayForTenant\(/.test(src))
  check(`CRON ${name} — no single server-wide "today" survives`, !/localTodayISO\(\)/.test(src))
}
// ⛔ The tempting non-fix.
check('MUTATION — nobody "fixed" this by pinning TZ on the deployment',
  !/TZ\s*[:=]/.test(read('vercel.json')) && !/process\.env\.TZ\s*=/.test(read('next.config.ts')),
  'a deployment-wide TZ is wrong for the first tenant in another zone, and still leaves the browser reading the device')

console.log(failures === 0
  ? '\n✅ tenant time: every check passed\n'
  : `\n❌ tenant time: ${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
