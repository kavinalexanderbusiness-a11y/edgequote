// ── THE tenant-local date boundary ───────────────────────────────────────────
//
// Pure, I/O-free, and the ONE place the product decides what day it is for a
// business. Every surface that says "today" — the dashboard, the schedule, the
// weather forecast, a reminder, a due date, a cron — asks this and nothing else.
//
// ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
// Three different notions of "today" coexisted, and they disagreed:
//
//   localTodayISO()          the RUNTIME's local date. In a browser that is the
//                            DEVICE's timezone — the owner's phone abroad, a
//                            laptop still set to another province. On the server
//                            it is UTC, because that is what Node gets on Vercel.
//                            133 call sites, and it silently means two different
//                            things depending on which side it ran.
//   new Date().toISOString() plain UTC, at 19 more call sites — including the
//     .slice(0,10)           Weather page, where from ~17:00 local onward UTC has
//                            already rolled over and "today" is tomorrow.
//   business_settings        the actual tenant IANA zone. It EXISTS, it is NOT
//     .timezone              NULL, it defaults to 'America/Edmonton' — and it had
//                            exactly ONE reader in the whole application
//                            (lib/comms/governor's quiet hours).
//
// So the setting was never missing. It was simply never consulted, and every
// surface answered "what day is it?" from whichever clock happened to be
// nearest. That is why the Dashboard, the Schedule and Weather could each show a
// different day at the same moment.
//
// ── THE TWO RULES THIS FILE EXISTS TO KEEP ───────────────────────────────────
//
// ⭐⭐ 1. IANA NAMES, NEVER FIXED OFFSETS. 'America/Edmonton', never '-06:00'.
// An offset is a fact about one instant, not about a place: Edmonton is -07:00
// for four months of the year and -06:00 for eight. Storing an offset means the
// business's day boundary silently moves by an hour twice a year, in opposite
// directions, and every date near midnight lands on the wrong day for a week
// until someone notices. The IANA database knows when the transitions are; we
// do not, and must never try to.
//
// ⭐⭐ 2. CALENDAR ARITHMETIC IS DONE ON THE DATE, NOT ON A CLOCK. "Tomorrow" is
// not "now + 86,400,000 ms". On the day a zone springs forward that sum lands 23
// hours later and can still be the SAME calendar day; on the day it falls back
// it can skip into the day after. addDaysISO works in UTC — where no DST exists
// — precisely so that a calendar day is always a calendar day.

// ── The zone ─────────────────────────────────────────────────────────────────

/**
 * What we use when a tenant's zone is missing or unusable.
 *
 * ⭐ It matches `business_settings.timezone`'s own column default, deliberately:
 * a fallback that disagreed with the schema default would mean a business whose
 * row has never been written renders one day on the server and another in the
 * browser. Same value, one answer.
 *
 * ⚠️ It is a FALLBACK, not a default anyone chose. Surfaces that care whether
 * the zone is real should ask `isValidTimeZone` rather than compare to this.
 */
export const FALLBACK_TIME_ZONE = 'America/Edmonton'

/**
 * Is this a zone the runtime can actually resolve?
 *
 * ⛔ Rejects fixed offsets on purpose. '-06:00', 'UTC-6' and 'GMT+2' are not
 * places and cannot express a DST transition, so accepting one would quietly
 * reintroduce the bug this file exists to remove. 'UTC' itself is allowed: it is
 * a real, offset-stable zone and a legitimate choice for a business that wants
 * it.
 */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  const s = (tz ?? '').trim()
  if (!s) return false
  // A zone name is Region/City (or a bare 'UTC'). Anything with a sign or digits
  // in the offset position is an offset wearing a zone's clothes.
  if (/^(utc|gmt)?[+-]\d/i.test(s)) return false
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(s)) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: s })
    return true
  } catch {
    return false
  }
}

/** The zone to actually use. Never throws, never returns something unusable. */
export function safeTimeZone(tz: string | null | undefined): string {
  return isValidTimeZone(tz) ? (tz as string).trim() : FALLBACK_TIME_ZONE
}

// ── The date ─────────────────────────────────────────────────────────────────

// One formatter per zone. Intl.DateTimeFormat construction is the expensive part
// and "what day is it" gets asked in render loops.
const fmtCache = new Map<string, Intl.DateTimeFormat>()
function dateFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    // en-CA gives yyyy-mm-dd, but the parts are read by NAME below rather than
    // by parsing the string — a locale that reordered them must not be able to
    // turn a date into a different date.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    fmtCache.set(tz, f)
  }
  return f
}

export interface TenantMoment {
  /** yyyy-MM-dd in the tenant's zone. */
  date: string
  /** 0–23 in the tenant's zone. */
  hour: number
  minute: number
}

/**
 * What the clock on the wall says, at this instant, in this business's zone.
 *
 * ⭐ Read by PART NAME, never by parsing the formatted string. `formatToParts`
 * is the only form that cannot be broken by a locale putting the day first.
 */
export function tenantMoment(tz: string | null | undefined, instant: Date = new Date()): TenantMoment {
  const zone = safeTimeZone(tz)
  const parts = dateFmt(zone).formatToParts(instant)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const y = get('year'), m = get('month'), d = get('day')
  // hour '24' is legal in hour12:false formatting and means midnight.
  const h = Number(get('hour'))
  return {
    date: `${y}-${m}-${d}`,
    hour: h === 24 ? 0 : h,
    minute: Number(get('minute')) || 0,
  }
}

/** THE answer to "what day is it for this business?" */
export function tenantTodayISO(tz: string | null | undefined, instant: Date = new Date()): string {
  return tenantMoment(tz, instant).date
}

/** The tenant-local calendar date of any instant (not just now). */
export function tenantDateISO(tz: string | null | undefined, instant: Date): string {
  return tenantMoment(tz, instant).date
}

/** Is this yyyy-MM-dd the business's today? */
export function isTenantToday(tz: string | null | undefined, iso: string, instant: Date = new Date()): boolean {
  return iso === tenantTodayISO(tz, instant)
}

// ── Calendar arithmetic ──────────────────────────────────────────────────────

/**
 * n days after (or before) a yyyy-MM-dd, as a calendar operation.
 *
 * ⚠️⚠️ THIS IS WHY IT WORKS IN UTC. Doing it with a local Date and setDate() is
 * usually right and wrong twice a year: on a spring-forward day the local day is
 * 23 hours long, on a fall-back day 25, and `new Date(iso).getTime() + 86400000`
 * lands on the wrong calendar date at both boundaries. UTC has no transitions,
 * so a day is always exactly a day there — and since the input and output are
 * both bare calendar dates with no zone attached, UTC is not an assumption about
 * the tenant, it is just arithmetic that cannot drift.
 */
export function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1))
  t.setUTCDate(t.getUTCDate() + n)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** Whole calendar days from `a` to `b` (negative when b is earlier). */
export function daysBetweenISO(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, (m || 1) - 1, d || 1) }
  return Math.round((p(b) - p(a)) / 86_400_000)
}

/** Day of week for a calendar date, 0 = Sunday. Zone-free by construction. */
export function dayOfWeekISO(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
}

/**
 * The INSTANT at which the tenant's calendar day begins, as a real Date.
 *
 * For querying timestamp columns ("everything logged today"), where a bare
 * calendar date is not enough and the offset must be the one in force ON THAT
 * DATE — which is exactly what makes a stored offset wrong.
 *
 * Three steps, and MEASURED rather than reasoned about (see the guard, which
 * runs every one of these against the real IANA data):
 *
 * ⭐ 1–2. TWO OFFSET PASSES. The first guess treats the wall clock as if it were
 * UTC and asks the zone how far off that lands; applying that correction can
 * itself cross a DST transition, so the offset is re-measured at the corrected
 * instant and applied again. For America/Edmonton the second pass changes
 * nothing — its transition is at 02:00, comfortably clear of midnight — but for
 * every zone that transitions NEAR midnight it does: Asia/Beirut, Pacific/
 * Chatham and Australia/Lord_Howe all land on the wrong side without it.
 *
 * ⭐⭐ 3. THEN CLAMP FORWARD, because in some zones MIDNIGHT DOES NOT EXIST.
 * America/Havana and America/Santiago spring forward AT 00:00, so on that date
 * the clock goes 23:59:59 → 01:00:00 and there is no 00:00 to find. Both offset
 * passes then settle on 23:00 of the PREVIOUS day — an instant that belongs to
 * yesterday, which would make "everything since the start of today" quietly
 * include last night. The day actually begins at the first instant that EXISTS
 * in it, so we step forward until the tenant-local date is genuinely `iso`.
 * Bounded: no zone has ever skipped more than two hours.
 */
export function startOfTenantDayUTC(tz: string | null | undefined, iso: string): Date {
  const zone = safeTimeZone(tz)
  const [y, m, d] = iso.split('-').map(Number)
  const asUTC = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0)
  let guess = new Date(asUTC - offsetMs(zone, new Date(asUTC)))
  guess = new Date(asUTC - offsetMs(zone, guess))

  // Walk onto the day if midnight was skipped, or back onto it if we overshot.
  // 15 minutes is the finest granularity any zone offset has ever used, and 16
  // steps covers a four-hour correction — far beyond anything real.
  for (let i = 0; i < 16 && tenantDateISO(zone, guess) < iso; i++) {
    guess = new Date(guess.getTime() + 15 * 60_000)
  }
  for (let i = 0; i < 16 && tenantDateISO(zone, guess) > iso; i++) {
    guess = new Date(guess.getTime() - 15 * 60_000)
  }
  return guess
}

/** The tenant zone's offset from UTC, in ms, AT a given instant. */
export function offsetMs(tz: string | null | undefined, instant: Date): number {
  const zone = safeTimeZone(tz)
  const p = dateFmt(zone).formatToParts(instant)
  const get = (t: string) => Number(p.find(x => x.type === t)?.value ?? 0)
  const h = get('hour')
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), h === 24 ? 0 : h, get('minute'))
  // Second-level precision is deliberately dropped: no IANA zone in use today
  // has a sub-minute offset, and keeping seconds would make this jitter.
  const actual = Math.floor(instant.getTime() / 60_000) * 60_000
  return wall - actual
}

/**
 * Does this calendar date contain a DST transition in this zone?
 *
 * Surfaced so a day view can say "clocks change today" rather than silently
 * being an hour short — and so the guard can find the transition dates for a
 * zone instead of hard-coding them and rotting when a government moves one.
 */
export function hasDstTransition(tz: string | null | undefined, iso: string): boolean {
  const zone = safeTimeZone(tz)
  const start = startOfTenantDayUTC(zone, iso)
  const next = startOfTenantDayUTC(zone, addDaysISO(iso, 1))
  return offsetMs(zone, start) !== offsetMs(zone, new Date(next.getTime() - 60_000))
}

/**
 * How many hours long the tenant's calendar day actually is.
 *
 * Usually 24; 23 or 25 on a DST boundary. ⚠️ Rounded to the HALF hour, not the
 * hour: Australia/Lord_Howe shifts by 30 minutes, so its short day is 23.5h and
 * rounding to whole hours would report a perfectly ordinary 24.
 */
export function tenantDayLengthHours(tz: string | null | undefined, iso: string): number {
  const zone = safeTimeZone(tz)
  const a = startOfTenantDayUTC(zone, iso).getTime()
  const b = startOfTenantDayUTC(zone, addDaysISO(iso, 1)).getTime()
  return Math.round(((b - a) / 3_600_000) * 2) / 2
}

// ── Saying it ────────────────────────────────────────────────────────────────

/**
 * ⭐ WHY THIS LIVES HERE AND NOT IN A COMPONENT. "Today" is not a formatting
 * choice, it is a CLAIM about which date this is — and the weather page proved
 * what happens when two surfaces each make it for themselves: one card was
 * hard-labelled "Today" while a second card, comparing against a different
 * clock, ALSO rendered "Today", for a different day.
 *
 * Every caller labels every day through this, so the word can attach to exactly
 * one date by construction.
 */
export type DayRole = 'past' | 'today' | 'tomorrow' | 'future'

export function dayRole(iso: string, todayISO: string): DayRole {
  if (iso === todayISO) return 'today'
  if (iso < todayISO) return 'past'
  return iso === addDaysISO(todayISO, 1) ? 'tomorrow' : 'future'
}

/**
 * The label for a calendar date, relative to the business's today.
 *
 * `withDate` appends the actual date to the relative words. A card three days
 * out that says only "Fri" is a card the owner has to count on their fingers to
 * place — and next Friday looks identical to this one.
 */
export function dayLabel(iso: string, todayISO: string, opts: { withDate?: boolean } = {}): string {
  const role = dayRole(iso, todayISO)
  const dated = formatMonthDay(iso)
  if (role === 'today') return opts.withDate ? `Today · ${dated}` : 'Today'
  if (role === 'tomorrow') return opts.withDate ? `Tomorrow · ${dated}` : 'Tomorrow'
  return opts.withDate ? `${weekdayShort(iso)} ${dated}` : `${weekdayShort(iso)} ${dated}`
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * ⭐ Formatted from the ISO PARTS, not by constructing a Date and letting the
 * runtime localise it. `new Date('2026-03-08').toLocaleDateString()` is
 * interpreted as UTC midnight and renders as the 7th for every viewer west of
 * Greenwich — a bare calendar date rendering as the previous day is the same
 * off-by-one this whole file exists to remove, arriving through the formatter.
 */
export function weekdayShort(iso: string): string {
  return WEEKDAYS_SHORT[dayOfWeekISO(iso)] ?? ''
}

export function formatMonthDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${MONTHS_SHORT[(m || 1) - 1] ?? ''} ${d || ''}`
}

export function formatFullDay(iso: string): string {
  const [y] = iso.split('-').map(Number)
  return `${weekdayShort(iso)}, ${formatMonthDay(iso)}, ${y}`
}
