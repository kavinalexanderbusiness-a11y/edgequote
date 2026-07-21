import type { SupabaseClient } from '@supabase/supabase-js'
import { msgCategory, type MsgType, MSG_LABELS } from './templates'
import { SENT_STATES } from './delivery'
import { SKIP_REASON, type SkipReason } from './skipReasons'

// ── The send governor — WHEN a message may go out ────────────────────────────
// Consent (lib/comms/reach) answers "may we contact this customer AT ALL".
// This answers the question no sender asked before it existed: "is NOW, and is
// AGAIN, acceptable?" Nine senders each carried their own per-template dedupe;
// none of them could see the others, so a customer could clear every consent
// gate and still get four commercial messages in a week from four different
// brains. This is the ONE cross-sender brain, and it runs inside
// dispatchToCustomer, so no sender — present or future — can forget it.
//
// Scope, deliberately narrow:
//  • Only COMMERCIAL categories are governed (marketing, seasonal — the CEM
//    classes). Service messages (reminders, invoices, estimates) follow the
//    customer's booking, not our calendar: an 07:50 on-my-way IS the business.
//    Owner-composed one-offs (custom / null category) are a conversation, not a
//    campaign — never governed.
//  • The OWNER DAILY CAP is the exception: it counts every logged send for the
//    owner regardless of category, because the runaway loop it guards against
//    doesn't care which template it's blasting.
//
// Failure semantics (the automation engine's lesson, applied symmetrically):
//  • Commercial send + unknown hour or failed count → BLOCKED. An uncertain
//    read must never license a 4am campaign or an over-cap blast.
//  • Service send + failed count → ALLOWED. A receipt must not die on a log
//    hiccup; service sends are only ever subject to the runaway cap, and a
//    runaway is a sustained condition the next successful read still catches.
//
// The DECISION is pure (governVerdict) so scripts/verify-comms-governor.ts pins
// every edge without a database — the seedPlan pattern.

/** Local send window for commercial messages: [08:00, 21:00) owner-local.
 *  Not statute (CASL sets no hours) — a courtesy window. It opens at 8, not 9,
 *  because cron/campaigns fires 15:00 UTC = 08:00 Mountain STANDARD time; a
 *  9am window would silently suppress every winter campaign run forever. */
export const SEND_WINDOW_START = 8
export const SEND_WINDOW_END = 21

/** No two commercial sends to the same customer within this many days —
 *  the cross-sender gap none of the per-template dedupers could enforce. */
export const COMMERCIAL_GAP_DAYS = 3
/** And never more than this many commercial sends per customer per 30 days. */
export const COMMERCIAL_CAP_30D = 8
/** Runaway guard: total logged sends per owner per UTC day, all categories.
 *  Sized far above legitimate peak (≈30 jobs/day × 3 messages ≈ 90) so the only
 *  thing that can hit it is a loop. */
export const OWNER_DAILY_CAP = 500

const GOVERNED = new Set(['marketing', 'seasonal'])

/** Is this template a governed (commercial) send? Unknown templates are treated
 *  as commercial: a template the registry doesn't know is exactly the kind of
 *  future sender this seam exists to catch — fail toward governance. */
export function isCommercial(template: string): boolean {
  if (!(template in MSG_LABELS)) return true
  const cat = msgCategory(template as MsgType)
  return cat != null && GOVERNED.has(cat)
}

/** The owner's current local hour, or 'unknown' when the timezone is missing or
 *  invalid. Never throws; never guesses from the server clock — the server's
 *  hour presented as the owner's is the exact bug the automation engine shipped. */
export function localHour(timezone: string | null | undefined, now: Date): number | 'unknown' {
  if (!timezone) return 'unknown'
  try {
    const h = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: 'numeric', hour12: false }).format(now)
    const n = Number(h)
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** What the impure loader hands the pure verdict. `null` on any field means the
 *  read FAILED — not zero, not "no sends"; the verdict must not treat them alike. */
export interface GovernorState {
  commercial: boolean
  hour: number | 'unknown'
  /** Commercial-class sends to THIS customer in the last COMMERCIAL_GAP_DAYS. null = read failed. */
  recentToCustomer: number | null
  /** Commercial-class sends to THIS customer in the last 30 days. null = read failed. */
  monthToCustomer: number | null
  /** ALL logged sends for the owner today (UTC). null = read failed. */
  ownerToday: number | null
}

export interface GovernorVerdict {
  allowed: boolean
  reason: SkipReason | null
}

/** PURE. Every rule, in the order the skip should be reported. */
export function governVerdict(s: GovernorState): GovernorVerdict {
  // Runaway guard first: it applies to everything, and when it trips, nothing
  // else about the send matters. A failed count only blocks commercial sends.
  if (s.ownerToday != null && s.ownerToday >= OWNER_DAILY_CAP) {
    return { allowed: false, reason: SKIP_REASON.DAILY_CAP }
  }

  if (!s.commercial) {
    // Service and conversational sends: subject to the runaway cap above and
    // nothing else. A failed read fails OPEN here — see the header.
    return { allowed: true, reason: null }
  }

  // Commercial: every uncertainty fails CLOSED.
  if (s.ownerToday == null) return { allowed: false, reason: SKIP_REASON.DAILY_CAP }
  if (s.hour === 'unknown') return { allowed: false, reason: SKIP_REASON.QUIET_HOURS }
  if (s.hour < SEND_WINDOW_START || s.hour >= SEND_WINDOW_END) {
    return { allowed: false, reason: SKIP_REASON.QUIET_HOURS }
  }
  if (s.recentToCustomer == null || s.monthToCustomer == null) {
    return { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP }
  }
  if (s.recentToCustomer > 0) return { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP }
  if (s.monthToCustomer >= COMMERCIAL_CAP_30D) return { allowed: false, reason: SKIP_REASON.FREQUENCY_CAP }

  return { allowed: true, reason: null }
}

// Templates whose log rows count as "commercial" for the gap/cap queries. Built
// once from the registry so the query and the verdict can never disagree.
const COMMERCIAL_TEMPLATES = (Object.keys(MSG_LABELS) as MsgType[]).filter(t => {
  const cat = msgCategory(t)
  return cat != null && GOVERNED.has(cat)
})

/** Load state + decide. One business_settings read and two/one count reads per
 *  dispatched customer — bulk paths pay N of these; at the current book size
 *  that is fine, and correctness beats a cache in wave 1. */
export async function governCheck(
  sb: SupabaseClient,
  inp: { userId: string; customerId: string; template: string; now?: Date },
): Promise<GovernorVerdict> {
  const now = inp.now ?? new Date()
  const commercial = isCommercial(inp.template)

  // A THROWN read is a FAILED read — same verdict, decided in one place
  // (governVerdict's null semantics): commercial blocks, service passes. This
  // also keeps dispatch working under partial clients (the automation harness
  // drives it with a mock that doesn't speak every query chain).
  try {
    const dayStartUtc = new Date(now); dayStartUtc.setUTCHours(0, 0, 0, 0)
    const gapStart = new Date(now.getTime() - COMMERCIAL_GAP_DAYS * 24 * 60 * 60 * 1000)
    const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // SENT_STATES, never status = 'sent': a delivery webhook advances rows and an
    // equality check would quietly stop counting them (the dedupe lesson).
    const sentStates = [...SENT_STATES]

    // Service sends need only the runaway count — don't pay (or depend on) the
    // timezone and per-customer reads that can't change their verdict.
    const [tzRes, todayRes, gapRes, monthRes] = await Promise.all([
      commercial
        ? sb.from('business_settings').select('timezone').eq('user_id', inp.userId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sb.from('notification_log').select('id', { count: 'exact', head: true })
        .eq('user_id', inp.userId).in('status', sentStates)
        .gte('created_at', dayStartUtc.toISOString()),
      commercial
        ? sb.from('notification_log').select('id', { count: 'exact', head: true })
            .eq('user_id', inp.userId).eq('customer_id', inp.customerId)
            .in('template', COMMERCIAL_TEMPLATES).in('status', sentStates)
            .gte('created_at', gapStart.toISOString())
        : Promise.resolve({ count: 0, error: null }),
      commercial
        ? sb.from('notification_log').select('id', { count: 'exact', head: true })
            .eq('user_id', inp.userId).eq('customer_id', inp.customerId)
            .in('template', COMMERCIAL_TEMPLATES).in('status', sentStates)
            .gte('created_at', monthStart.toISOString())
        : Promise.resolve({ count: 0, error: null }),
    ])

    const tz = tzRes.error ? null : (tzRes.data as { timezone: string | null } | null)?.timezone ?? null

    return governVerdict({
      commercial,
      hour: commercial ? localHour(tz, now) : 0,
      recentToCustomer: gapRes.error || gapRes.count == null ? null : gapRes.count,
      monthToCustomer: monthRes.error || monthRes.count == null ? null : monthRes.count,
      ownerToday: todayRes.error || todayRes.count == null ? null : todayRes.count,
    })
  } catch {
    return governVerdict({
      commercial, hour: 'unknown',
      recentToCustomer: null, monthToCustomer: null, ownerToday: null,
    })
  }
}
