import type { SupabaseClient } from '@supabase/supabase-js'
import { tradePack, type TradePack } from '@/lib/trades'

// ── First-run seeding — the ONLY writer of trade-pack data ───────────────────
// Turns a TradePack into a new business's starting configuration. The one rule,
// enforced structurally: seeding only ever fills EMPTINESS. A surface that has
// ANY owner data — even one service template, even a deliberately-emptied
// module list — is never written, so re-running is always safe and an existing
// business is byte-identical by construction (every gate reads "has data" and
// closes). There is no force flag. There is no merge. Deleting a pack service
// the owner didn't want must never be undone by a reseed.
//
// The DECISION is a pure function (seedPlan) so the no-overwrite guarantee is
// testable without a database — scripts/verify-onboarding.ts pins it in CI,
// including the "existing business → nothing seeds" case.
//
// What each surface seeds and when:
//   business_type     always written on apply — it IS the owner's selection
//   service_templates only when the business has ZERO templates (active OR not:
//                     a deactivated catalogue is still an owner's catalogue)
//   service_seasons   only when the column is NULL (a lawn business's stored
//                     {lawn, snow} — or an owner-cleared {} — both count as
//                     configuration and are never touched)
//   enabled_modules   only when the column is NULL and the pack has an opinion.
//                     NULL means "all modules" (lib/modules.ts), which is also
//                     what every pack currently recommends — so this writes
//                     nothing today and exists as the seam for real opinions.
//
// Campaign presets are deliberately NOT seeded as rows: the campaign studio's
// built-in preset list is itself derived from the business's pack (see
// CampaignManager), so writing copies into crm_campaign_presets would show the
// owner every preset twice. No rows = nothing to overwrite = nothing to drift.

export interface SeedState {
  /** Does a business_settings row exist at all? */
  hasSettingsRow: boolean
  businessType: string | null
  /** ALL templates, active or not — a disabled catalogue is still owner data. */
  serviceTemplateCount: number
  /** service_seasons column is non-NULL (any object, even {}). */
  seasonsConfigured: boolean
  /** enabled_modules column is non-NULL (any array, even []). */
  modulesConfigured: boolean
  /** A read failed. When set, the state's "emptiness" is UNKNOWN, not empty, and
   *  seeding MUST abort — never seed on a guess. Absent = the reads succeeded. */
  readError?: string
}

export interface SeedPlan {
  seedServices: boolean
  seedSeasons: boolean
  seedModules: boolean
  /** Human-readable reason per skipped surface — shown in the setup UI so
   *  "nothing happened" is never a mystery. */
  skipped: { surface: 'services' | 'seasons' | 'modules'; reason: string }[]
}

/** PURE. Given what the business already has and what the pack offers, decide
 *  what seeding may touch. Every gate closes on the presence of owner data. */
export function seedPlan(state: SeedState, pack: TradePack): SeedPlan {
  const skipped: SeedPlan['skipped'] = []

  let seedServices = false
  if (state.serviceTemplateCount > 0) {
    skipped.push({ surface: 'services', reason: `keeping your ${state.serviceTemplateCount} existing service${state.serviceTemplateCount === 1 ? '' : 's'} — seeding never touches a configured catalogue` })
  } else if (pack.services.length === 0) {
    skipped.push({ surface: 'services', reason: 'this pack has no starter catalogue' })
  } else {
    seedServices = true
  }

  let seedSeasons = false
  if (state.seasonsConfigured) {
    skipped.push({ surface: 'seasons', reason: 'your season windows are already set — seeding never changes them' })
  } else if (Object.keys(pack.seasons).length === 0) {
    skipped.push({ surface: 'seasons', reason: 'this trade runs year-round by default — add seasons in Settings if yours doesn’t' })
  } else {
    seedSeasons = true
  }

  let seedModules = false
  if (state.modulesConfigured) {
    skipped.push({ surface: 'modules', reason: 'your module selection is already set — seeding never changes it' })
  } else if (!pack.modules) {
    skipped.push({ surface: 'modules', reason: 'this trade uses every module (the default)' })
  } else {
    seedModules = true
  }

  return { seedServices, seedSeasons, seedModules, skipped }
}

/** The engine-facing season shape: for the built-in lawn/snow keys the engine
 *  resolves by its own hint constants and IGNORES a stored `match`, so writing
 *  one would be dead data pretending to matter — strip it. Custom keys keep
 *  `match`: it's exactly what the generalised engine consults for them. */
export function seasonsForStorage(pack: TradePack): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, s] of Object.entries(pack.seasons)) {
    out[key] = key === 'lawn' || key === 'snow'
      ? { label: s.label, startMonth: s.startMonth, startDay: s.startDay, endMonth: s.endMonth, endDay: s.endDay }
      : { label: s.label, match: s.match, startMonth: s.startMonth, startDay: s.startDay, endMonth: s.endMonth, endDay: s.endDay }
  }
  return out
}

/** The rows a pack's catalogue seeds. sort_order preserves the pack's curated
 *  order (bread-and-butter first), mirroring the templates page's own idiom. */
export function serviceRowsFor(pack: TradePack, userId: string) {
  return pack.services.map((s, i) => ({
    user_id: userId,
    name: s.name,
    category: s.category,
    default_rate: s.default_rate,
    pricing_display_type: s.pricing_display_type,
    default_description: s.default_description ?? null,
    is_active: true,
    sort_order: i,
  }))
}

/** Read the live state the plan gates on. A failed read returns readError and a
 *  state that LOOKS fully configured, so seedPlan skips everything — the emptiness
 *  the gates check for is a fact we couldn't establish, and "don't know" must never
 *  read as "empty" (that would let a dropped connection license an overwrite). The
 *  count query is asserted, not `?? 0`'d: a null count on error is exactly the trap. */
export async function loadSeedState(supabase: SupabaseClient, userId: string): Promise<SeedState> {
  const [settingsRes, tplRes] = await Promise.all([
    supabase.from('business_settings').select('business_type, service_seasons, enabled_modules').eq('user_id', userId).maybeSingle(),
    supabase.from('service_templates').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ])
  const readError = settingsRes.error?.message || tplRes.error?.message || (tplRes.count == null ? 'service template count unavailable' : undefined)
  if (readError) {
    // Fail closed: present every surface as already-configured so nothing seeds.
    return { hasSettingsRow: true, businessType: null, serviceTemplateCount: 1, seasonsConfigured: true, modulesConfigured: true, readError }
  }
  const s = settingsRes.data as { business_type: string | null; service_seasons: unknown; enabled_modules: unknown } | null
  return {
    hasSettingsRow: !!s,
    businessType: s?.business_type ?? null,
    serviceTemplateCount: tplRes.count ?? 0,
    seasonsConfigured: s != null && s.service_seasons != null,
    modulesConfigured: s != null && s.enabled_modules != null,
  }
}

export interface SeedResult {
  ok: boolean
  error?: string
  plan: SeedPlan
  seeded: { services: number; seasons: number; modules: number }
}

/** Apply a trade selection: write business_type, then seed ONLY what the plan
 *  allows. Never throws for a per-surface failure — the setup screen shows the
 *  honest per-surface outcome instead of a mystery half-state. */
export async function applyTradeSelection(supabase: SupabaseClient, userId: string, packKey: string): Promise<SeedResult> {
  const pack = tradePack(packKey)
  const state = await loadSeedState(supabase, userId)
  const plan = seedPlan(state, pack)
  const seeded = { services: 0, seasons: 0, modules: 0 }

  // If we couldn't read what the business already has, we cannot know what is
  // safe to seed — so seed NOTHING and say so, rather than write business_type
  // and report a hollow success. The owner retries; nothing was touched.
  if (state.readError) {
    return { ok: false, error: `Couldn’t check your existing setup (${state.readError}) — nothing was changed. Please try again.`, plan, seeded }
  }

  // The selection itself. Upsert keyed on the existing unique(user_id): a brand
  // new account has NO business_settings row (nothing creates one at signup),
  // and every other column has a DB default — so this both records the choice
  // and, for a first run, brings the row into existence.
  const { error: typeErr } = await supabase.from('business_settings')
    .upsert({ user_id: userId, business_type: pack.key }, { onConflict: 'user_id' })
  if (typeErr) return { ok: false, error: `Could not save the business type: ${typeErr.message}`, plan, seeded }

  if (plan.seedServices) {
    const { error } = await supabase.from('service_templates').insert(serviceRowsFor(pack, userId))
    if (error) return { ok: false, error: `Could not seed the starter catalogue: ${error.message}`, plan, seeded }
    seeded.services = pack.services.length
  }

  if (plan.seedSeasons) {
    const { error } = await supabase.from('business_settings')
      .update({ service_seasons: seasonsForStorage(pack) }).eq('user_id', userId)
    if (error) return { ok: false, error: `Could not seed the season windows: ${error.message}`, plan, seeded }
    seeded.seasons = Object.keys(pack.seasons).length
  }

  if (plan.seedModules && pack.modules) {
    const { error } = await supabase.from('business_settings')
      .update({ enabled_modules: pack.modules }).eq('user_id', userId)
    if (error) return { ok: false, error: `Could not set the recommended modules: ${error.message}`, plan, seeded }
    seeded.modules = pack.modules.length
  }

  return { ok: true, plan, seeded }
}
