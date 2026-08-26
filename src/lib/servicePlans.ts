import type { SupabaseClient } from '@supabase/supabase-js'
import type { ServicePricingPlanRow } from '@/types'
import type { ServicePricingPlan, PricingTerm, PriceBasis } from '@/lib/measurePricing'
import { PRICING_TERMS, isPricingTerm } from '@/lib/measurePricing'

// ── Reading and writing the ways a service is sold ───────────────────────────
// The IO half of Measure & Price V2. lib/measurePricing stays PURE — it does the
// arithmetic and knows nothing about a database; this file does the database and
// knows nothing about arithmetic. That split is why the pricing rules are
// testable without a Supabase, which is what verify:measure-price relies on.
//
// ⭐ TENANCY IS NOT ENFORCED HERE, AND MUST NOT BE.
// Every call below passes `user_id`, but the guarantee comes from two things in
// the database, not from this code:
//   • RLS — `auth.uid() = user_id` on all four verbs, so a caller cannot read or
//     write another tenant's plans even if it lies about user_id.
//   • The COMPOSITE foreign key (service_template_id, user_id) → service_templates
//     (id, user_id) — so a plan cannot be attached to a service belonging to
//     someone else, even with a valid session and a foreign template id. The
//     insert fails at the constraint, not at a check somebody could forget.
// A client-side predicate here would be a third answer to a question the database
// already answers twice, and the weakest of the three.

/** Sorted the way the owner arranged them. */
export async function loadPricingPlans(
  supabase: SupabaseClient,
  userId: string,
  serviceTemplateId?: string | null,
): Promise<ServicePricingPlanRow[]> {
  let q = supabase
    .from('service_pricing_plans')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true })
  if (serviceTemplateId) q = q.eq('service_template_id', serviceTemplateId)
  const { data, error } = await q
  // A failed read is "we don't know", not "there are no plans" — but the callers
  // that matter (the map's plan chooser) already render an explicit unpriced
  // sentence when the list is empty, so an empty array degrades to
  // "pricing not configured" rather than to a fabricated price.
  if (error) throw error
  return (data || []) as ServicePricingPlanRow[]
}

/** Group by service, for surfaces holding the whole catalogue at once. */
export function plansByTemplate(rows: ServicePricingPlanRow[]): Map<string, ServicePricingPlanRow[]> {
  const m = new Map<string, ServicePricingPlanRow[]>()
  for (const r of rows) {
    const list = m.get(r.service_template_id)
    if (list) list.push(r)
    else m.set(r.service_template_id, [r])
  }
  for (const list of m.values()) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  return m
}

/** DB rows → the pure engine's input shape. */
export function toPricingPlans(rows: ServicePricingPlanRow[] | null | undefined): ServicePricingPlan[] {
  return (rows || [])
    .filter(r => isPricingTerm(r.term))
    .map(r => ({
      id: r.id,
      service_template_id: r.service_template_id,
      term: r.term as PricingTerm,
      basis: r.basis as PriceBasis,
      rate: Number(r.rate) || 0,
      is_recommended: !!r.is_recommended,
      sort_order: r.sort_order ?? 0,
    }))
}

/** What the Price Book editor holds while the owner is still typing. */
export interface PlanDraft {
  term: PricingTerm
  enabled: boolean
  basis: PriceBasis
  /** STRING, not number: `Number('')` is 0, and a plan the owner left blank must
   *  not silently become a $0 plan. Mapped on save, refused when blank. */
  rate: string
  is_recommended: boolean
}

/** One draft per term, seeded from whatever the owner has already saved. */
export function draftsFor(rows: ServicePricingPlanRow[] | null | undefined): PlanDraft[] {
  const byTerm = new Map((rows || []).map(r => [r.term, r]))
  return PRICING_TERMS.map(t => {
    const row = byTerm.get(t.key)
    return {
      term: t.key,
      enabled: !!row,
      // per_unit is the default for a NEW plan only when nothing is saved; an
      // existing row always shows what it actually is.
      basis: (row?.basis as PriceBasis) ?? 'per_unit',
      rate: row ? String(row.rate) : '',
      is_recommended: !!row?.is_recommended,
    }
  })
}

export type PlanProblem = 'no_rate' | 'negative_rate' | 'many_recommended'

/**
 * Why this set of drafts cannot be saved, or null. Pure, so the editor's inline
 * message and verify:measure-price come from ONE rule.
 *
 * A blank or zero rate on an ENABLED plan is refused rather than stored: the
 * whole point of this feature is that an unknown price stays unknown, and a
 * stored 0 would be a configured claim that the work is free.
 */
export function planSetProblem(drafts: PlanDraft[]): PlanProblem | null {
  const on = drafts.filter(d => d.enabled)
  for (const d of on) {
    const n = Number(String(d.rate).trim())
    if (!String(d.rate).trim() || !Number.isFinite(n) || n === 0) return 'no_rate'
    if (n < 0) return 'negative_rate'
  }
  if (on.filter(d => d.is_recommended).length > 1) return 'many_recommended'
  return null
}

export const PLAN_PROBLEM_MESSAGE: Record<PlanProblem, string> = {
  no_rate: 'Give every plan you offer a rate — a plan with no rate can’t price anything, and storing zero would tell customers the work is free.',
  negative_rate: 'A rate can’t be negative.',
  many_recommended: 'Only one plan can be marked Recommended.',
}

/**
 * Replace this service's plans with exactly what the owner ticked.
 *
 * Delete-then-insert rather than a diff: the set is at most five rows, the
 * unique (service_template_id, term) constraint makes an upsert-by-term fiddly,
 * and "the rows that exist ARE the offers" is easiest to keep true when the
 * write says precisely that. Both statements are scoped by user_id so a
 * mis-passed template id can only ever affect the caller's own rows — and the
 * composite FK refuses the insert outright if the template is not theirs.
 */
export async function savePricingPlans(
  supabase: SupabaseClient,
  userId: string,
  serviceTemplateId: string,
  drafts: PlanDraft[],
): Promise<void> {
  const problem = planSetProblem(drafts)
  if (problem) throw new Error(PLAN_PROBLEM_MESSAGE[problem])

  const { error: delErr } = await supabase
    .from('service_pricing_plans')
    .delete()
    .eq('user_id', userId)
    .eq('service_template_id', serviceTemplateId)
  if (delErr) throw delErr

  // Ordered by the catalogue, so the owner reads One-time → … → Seasonal
  // wherever the plans appear, without a drag handle nobody asked for.
  const order = new Map(PRICING_TERMS.map((t, i) => [t.key, i]))
  const rows = drafts
    .filter(d => d.enabled)
    .map(d => ({
      user_id: userId,
      service_template_id: serviceTemplateId,
      term: d.term,
      basis: d.basis,
      rate: Number(String(d.rate).trim()),
      is_recommended: !!d.is_recommended,
      sort_order: order.get(d.term) ?? 0,
    }))
  if (!rows.length) return

  const { error: insErr } = await supabase.from('service_pricing_plans').insert(rows)
  if (insErr) throw insErr
}
