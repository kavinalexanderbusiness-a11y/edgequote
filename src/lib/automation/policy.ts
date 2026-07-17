// ── Chase policy — THE "how often, how many times" resolver ──────────────────
// Every automatic chaser needs the same thing: read the owner's tuning off the
// business_settings.automations jsonb, tolerate garbage, and clamp it so a bad
// value can never turn the chaser into a same-day spammer or an endless one.
//
// The quote chaser and the invoice chaser each wrote this out in full — same
// parse, same clamps, same fallback shape, same comment. A third chaser would
// have copied it again. The RULE lives here; each chaser supplies only what is
// genuinely its own: which jsonb keys it reads and what it defaults to.

export interface ChasePolicy {
  delayDays: number   // quiet days before chasing (again)
  maxCount: number    // total automatic chases
}

// The guard rails. A chaser may be tuned within these and nowhere near outside.
export const CHASE_DELAY_MIN_DAYS = 1
export const CHASE_DELAY_MAX_DAYS = 60
export const CHASE_MAX_COUNT_CEILING = 10

export interface ChasePolicyKeys {
  /** jsonb key holding the delay, e.g. 'quote_followup_delay_days'. */
  delayKey: string
  /** jsonb key holding the cap, e.g. 'quote_followup_max'. */
  maxKey: string
}

/** Tolerant + clamped: a garbage/absent value falls back to `defaults`, and a
 *  hostile one is bounded — min 1 day between chases, never more than 10 sends. */
export function resolveChasePolicy(raw: unknown, keys: ChasePolicyKeys, defaults: ChasePolicy): ChasePolicy {
  const a = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
  const d = Math.floor(Number(a[keys.delayKey]))
  const m = Math.floor(Number(a[keys.maxKey]))
  return {
    delayDays: Number.isFinite(d) && d >= CHASE_DELAY_MIN_DAYS ? Math.min(d, CHASE_DELAY_MAX_DAYS) : defaults.delayDays,
    maxCount: Number.isFinite(m) && m >= 0 ? Math.min(m, CHASE_MAX_COUNT_CEILING) : defaults.maxCount,
  }
}
