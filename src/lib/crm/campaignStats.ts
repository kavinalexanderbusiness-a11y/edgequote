// ── Campaign analytics + history (read-only) ─────────────────────────────────
// Reads what the campaign engine already writes — crm_campaign_log (one row per
// campaign × customer × period, finalized with the real send outcome) joined to
// notification_log for delivery/open timestamps. Writes NOTHING and sends
// NOTHING; every number here is a fact the send path recorded.
//
// Deliberately NOT a revenue-attribution model: revenue rolls up by
// customers.acquisition_source elsewhere, and inventing a second attribution
// path here would put two engines on one question.

import type { SupabaseClient } from '@supabase/supabase-js'

// The outcomes the cron finalizes a claimed row to (route.ts). 'sending' is a
// live claim — a row still mid-flight, or one orphaned by a crashed run.
export type CampaignSendStatus = 'sending' | 'sent' | 'skipped' | 'failed'

export interface CampaignStats {
  sent: number
  skipped: number
  failed: number
  pending: number      // claimed but not finalized
  total: number
  delivered: number    // provider confirmed delivery
  opened: number       // email opens (SMS never reports opens)
  lastSentAt: string | null
}

export interface CampaignHistoryRow {
  id: string
  createdAt: string
  customerId: string
  customerName: string
  periodKey: string
  channel: string | null
  status: CampaignSendStatus
  detail: string | null
  deliveredAt: string | null
  openedAt: string | null
}

export const EMPTY_STATS: CampaignStats = {
  sent: 0, skipped: 0, failed: 0, pending: 0, total: 0, delivered: 0, opened: 0, lastSentAt: null,
}

const CHUNK = 100   // .in() lists ride the request URI — keep them short

interface LogRow {
  id: string
  created_at: string
  campaign_id: string
  customer_id: string
  period_key: string
  channel: string | null
  status: string | null
  detail: string | null
  message_id: string | null
}

function bumpStatus(s: CampaignStats, status: string | null) {
  s.total++
  switch (status) {
    case 'sent': s.sent++; break
    case 'skipped': s.skipped++; break
    case 'failed': s.failed++; break
    // A null status is a claim written before the outcome landed — same thing
    // as an explicit 'sending'. Count it as pending rather than dropping it, so
    // the totals always add up to the number of rows.
    default: s.pending++
  }
}

// Delivery/open timestamps for a set of message ids, from the comms audit log.
// crm_campaign_log stores the message_id dispatch returned; notification_log is
// where the provider webhooks land.
async function deliveryByMessageId(
  sb: SupabaseClient, messageIds: string[],
): Promise<Map<string, { deliveredAt: string | null; openedAt: string | null }>> {
  const out = new Map<string, { deliveredAt: string | null; openedAt: string | null }>()
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const { data } = await sb
      .from('notification_log')
      .select('message_id, delivered_at, opened_at')
      .in('message_id', messageIds.slice(i, i + CHUNK))
    for (const r of (data as { message_id: string | null; delivered_at: string | null; opened_at: string | null }[]) || []) {
      if (!r.message_id) continue
      // One message can log per channel; keep the first timestamp we see for each.
      const prev = out.get(r.message_id)
      out.set(r.message_id, {
        deliveredAt: prev?.deliveredAt ?? r.delivered_at,
        openedAt: prev?.openedAt ?? r.opened_at,
      })
    }
  }
  return out
}

/**
 * Per-campaign send counts, keyed by campaign id. One query for the whole set
 * plus one chunked lookup for delivery — not a query per campaign.
 */
export async function loadCampaignStats(
  sb: SupabaseClient, campaignIds: string[],
): Promise<Record<string, CampaignStats>> {
  const out: Record<string, CampaignStats> = {}
  for (const id of campaignIds) out[id] = { ...EMPTY_STATS }
  if (!campaignIds.length) return out

  const rows: LogRow[] = []
  for (let i = 0; i < campaignIds.length; i += CHUNK) {
    const { data } = await sb
      .from('crm_campaign_log')
      .select('id, created_at, campaign_id, customer_id, period_key, channel, status, detail, message_id')
      .in('campaign_id', campaignIds.slice(i, i + CHUNK))
      .order('created_at', { ascending: false })
    rows.push(...((data as LogRow[]) || []))
  }
  if (!rows.length) return out

  const delivery = await deliveryByMessageId(sb, rows.map(r => r.message_id).filter((m): m is string => !!m))

  for (const r of rows) {
    const s = out[r.campaign_id]
    if (!s) continue
    bumpStatus(s, r.status)
    if (r.status === 'sent' && !s.lastSentAt) s.lastSentAt = r.created_at   // rows are newest-first
    const d = r.message_id ? delivery.get(r.message_id) : undefined
    if (d?.deliveredAt) s.delivered++
    if (d?.openedAt) s.opened++
  }
  return out
}

/**
 * One campaign's send history, newest first — who it reached, when, on what
 * channel, and what happened.
 */
export async function loadCampaignHistory(
  sb: SupabaseClient, campaignId: string, limit = 50,
): Promise<CampaignHistoryRow[]> {
  const { data } = await sb
    .from('crm_campaign_log')
    .select('id, created_at, campaign_id, customer_id, period_key, channel, status, detail, message_id, customers(name)')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(limit)

  const rows = (data as (LogRow & { customers: { name: string } | { name: string }[] | null })[]) || []
  if (!rows.length) return []

  const delivery = await deliveryByMessageId(sb, rows.map(r => r.message_id).filter((m): m is string => !!m))

  return rows.map(r => {
    const cust = Array.isArray(r.customers) ? r.customers[0] : r.customers
    const d = r.message_id ? delivery.get(r.message_id) : undefined
    return {
      id: r.id,
      createdAt: r.created_at,
      customerId: r.customer_id,
      customerName: cust?.name || 'Unknown customer',
      periodKey: r.period_key,
      channel: r.channel,
      status: (r.status || 'sending') as CampaignSendStatus,
      detail: r.detail,
      deliveredAt: d?.deliveredAt ?? null,
      openedAt: d?.openedAt ?? null,
    }
  })
}

// Human wording for a send outcome — one vocabulary for every campaign surface.
export function describeCampaignStatus(s: CampaignSendStatus): string {
  switch (s) {
    case 'sent': return 'Sent'
    case 'skipped': return 'Skipped'
    case 'failed': return 'Failed'
    case 'sending': return 'In progress'
  }
}

// A one-line summary for a campaign card. Honest about an empty history rather
// than showing a row of zeroes.
export function summarizeStats(s: CampaignStats): string {
  if (!s.total) return 'No sends yet'
  const parts = [`${s.sent} sent`]
  if (s.delivered) parts.push(`${s.delivered} delivered`)
  if (s.opened) parts.push(`${s.opened} opened`)
  if (s.skipped) parts.push(`${s.skipped} skipped`)
  if (s.failed) parts.push(`${s.failed} failed`)
  return parts.join(' · ')
}
