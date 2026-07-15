import type { SupabaseClient } from '@supabase/supabase-js'
import type { MsgType } from '@/lib/comms/templates'
import { resolveAutomations, type Automations } from '@/lib/comms/automations'
import type { FeeSettings } from '@/lib/invoiceTotals'

// ── loadOwnerContext — THE per-owner settings read ───────────────────────────
// Four crons (campaigns, notifications, quote-followup, invoice-reminders) each
// opened with the same paragraph: read business_settings for one owner, then
// re-type the same `company_name || <default>` fallback underneath it. Four
// copies of a settings read, four copies of the company-name fallback — and a
// fifth cron would have written a fifth of each, because copying the one next
// door is always the path of least resistance.
//
// That fallback is the reason this file exists rather than a comment asking
// people to be careful. It is the name a CUSTOMER reads when an owner hasn't set
// theirs — it signs their reminders and their review requests. Spread across four
// files it isn't a default, it's four defaults that agree today; the first one
// anybody re-words is the one where they text a stranger a different company's
// name. There is now exactly one place to change it.
//
// It selects the UNION of what the four asked for in ONE query — the same
// one-row-per-owner cost any single caller already paid, since the row is fetched
// either way and a wider column list rides along free. Callers take what they
// need and ignore the rest. A fifth cron adds a field here, not a fifth read.
//
// CACHING IS THE CALLER'S JOB, deliberately. The two chasers get it for free —
// runChaseCron already memoises loadContext per user_id — while campaigns and
// notifications call this inside their own loops and keep their own cache. One
// settings read per owner per run, everywhere, exactly as before.

/** Every per-owner setting the scheduled senders read, resolved once. */
export interface OwnerContext {
  /** The business name a customer sees. The fallback lives HERE and nowhere else. */
  name: string
  templates: Partial<Record<MsgType, string>> | null
  logoUrl: string | null
  website: string | null
  phone: string | null
  reviewUrl: string | null
  /** Which automations the owner switched on (resolveAutomations — the one engine). */
  automations: Automations
  /** The untouched jsonb. The chasers resolve their OWN policy (follow-up cadence,
   *  reminder cadence) from this — those live with their engines, not here. */
  automationsRaw: unknown
  /** The SAME fee/GST settings every balance is computed with, so a message can
   *  never disagree with the amount on the invoice or the portal. */
  fees: FeeSettings
}

interface SettingsRow {
  company_name: string | null
  phone: string | null
  website: string | null
  logo_url: string | null
  review_url: string | null
  message_templates: Partial<Record<MsgType, string>> | null
  automations: unknown
}

/** One row, one round-trip. Missing settings resolve to the same defaults an
 *  absent column always did — an owner who never opened Settings still sends. */
export async function loadOwnerContext(sb: SupabaseClient, userId: string): Promise<OwnerContext> {
  const { data } = await sb.from('business_settings')
    .select('company_name, phone, website, logo_url, review_url, message_templates, automations, payment_fee_strategy, fee_recovery_percent, gst_percent')
    .eq('user_id', userId).maybeSingle()
  const d = data as (SettingsRow & FeeSettings) | null
  return {
    // Never another company's name. This context feeds every AUTOMATED send
    // (reminders, follow-ups, campaigns), and the comment above is proud that an
    // owner who never opened Settings still sends — which is exactly the operator
    // whose customers were getting messages signed "Edge Property Services".
    name: d?.company_name || 'your service provider',
    templates: d?.message_templates ?? null,
    logoUrl: d?.logo_url ?? null,
    website: d?.website ?? null,
    phone: d?.phone ?? null,
    reviewUrl: d?.review_url ?? null,
    automations: resolveAutomations(d?.automations),
    automationsRaw: d?.automations,
    fees: {
      payment_fee_strategy: d?.payment_fee_strategy ?? null,
      fee_recovery_percent: d?.fee_recovery_percent ?? null,
      gst_percent: d?.gst_percent ?? null,
    },
  }
}
