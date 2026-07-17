// ── Marketing performance, composed (not computed) ───────────────────────────
// The analytics workspace's Marketing widget needs campaign outcomes. Those are
// ALREADY computed by lib/crm/campaignStats (loadCampaignStats reads what the
// send path recorded, and summarizeStats phrases it). This file adds NO analytics
// of its own: it fetches the campaign rows those stats belong to and pairs each
// name with its stats object. Every number the widget shows is returned verbatim
// by campaignStats — there is deliberately no arithmetic in this file, so it has
// no way to disagree with the Grow page, which reads the same engine.
//
// WHY THIS EXISTS AT ALL: CampaignManager queries crm_campaigns inline and calls
// loadCampaignStats itself. Rather than paste that pair a second time, the join
// lives here once and the widget consumes it.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//  • No cross-campaign totals. A "142 sent across all campaigns" headline is a
//    figure no engine defines; summing it here would invent the metric and let
//    it drift from what `sent` means to the send path. Per-campaign is what the
//    engine knows, so per-campaign is what we show.
//  • No revenue attribution. campaignStats.ts is explicit that attribution is a
//    separate question, and a second attribution path here would put two engines
//    on it. (Note: its header says revenue "rolls up by acquisition_source
//    elsewhere" — as of this commit no engine actually does that. The comment
//    describes an intent, not code.)

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCampaignStats, EMPTY_STATS, type CampaignStats } from '@/lib/crm/campaignStats'

export interface MarketingCampaignRow {
  id: string
  name: string
  kind: string
  enabled: boolean
  lastRunAt: string | null
  /** Verbatim from loadCampaignStats — never recomputed here. */
  stats: CampaignStats
}

/**
 * Every campaign with the outcomes the send path recorded for it.
 *
 * Disabled campaigns are INCLUDED: they still carry the history of what they
 * sent while they were on, and dropping them would make past sends vanish from
 * analytics the moment someone flips a toggle.
 *
 * Ordered by most-recently-run first, so the campaigns actually doing work lead
 * and never-run ones sink — `last_run_at` is null until the cron finalizes a run,
 * and Postgres sorts nulls last under `nullsFirst: false`.
 */
export async function loadMarketingPerformance(sb: SupabaseClient): Promise<MarketingCampaignRow[]> {
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return []

  const { data } = await sb
    .from('crm_campaigns')
    .select('id, name, kind, enabled, last_run_at')
    .eq('user_id', user.id)
    .order('last_run_at', { ascending: false, nullsFirst: false })

  const rows = (data as { id: string; name: string; kind: string; enabled: boolean; last_run_at: string | null }[]) || []
  if (!rows.length) return []

  // THE engine. Chunking, delivery/open joins and status semantics all live in
  // it; this call is the only place those numbers come from.
  const statsById = await loadCampaignStats(sb, rows.map(r => r.id))

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled,
    lastRunAt: r.last_run_at,
    // EMPTY_STATS is the engine's own zero value — a campaign that has never run
    // has no log rows, and that is not the same thing as an error.
    stats: statsById[r.id] ?? EMPTY_STATS,
  }))
}
