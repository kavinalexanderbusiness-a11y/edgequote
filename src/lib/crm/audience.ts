// ── Campaign audience (the ONE resolver) ─────────────────────────────────────
// Who does a campaign reach? Answered once, here, and consumed by BOTH:
//   • /api/cron/campaigns  → resolveAudience()  — who fires TODAY, to send to
//   • the Campaign Manager → previewAudience()  — who is eligible, to show
// If the preview built its own query it would drift from the sender, and the
// owner would be shown a promise the cron doesn't keep. Same filters, one place.
//
// The only difference between the two is deliberate and documented on
// previewAudience: the preview does NOT apply today's date match, because a
// birthday campaign would otherwise always preview "0 customers".

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampaignKind, CampaignAudience, CampaignSchedule } from '@/types'
import type { MessagePrefs, MsgType } from '@/lib/comms/templates'
import { blockedReason } from '@/lib/comms/reach'
import { describeSkip } from '@/lib/comms/skipReasons'
import { dateFieldFiresToday } from './campaigns'

// Everything dispatch needs, plus the fields the trigger rules match on.
export const AUDIENCE_SELECT =
  'id, name, phone, email, sms_opt_in, email_opt_in, message_prefs, birthday, anniversary'

export interface AudienceCustomer {
  id: string
  name: string
  phone: string | null
  email: string | null
  sms_opt_in: boolean
  email_opt_in: boolean
  message_prefs?: MessagePrefs | null
  birthday: string | null
  anniversary: string | null
}

export interface AudienceSpec {
  userId: string
  kind: CampaignKind
  schedule: CampaignSchedule
  audience: CampaignAudience
  today: Date
}

// Safety bound; reported, never silently applied (see `capped`).
export const MAX_AUDIENCE = 2000
// PostgREST puts `.in()` lists in the URI — a single 2000-id filter blows the URL
// length limit and the query fails outright. Chunk every id list through this.
const IN_CHUNK = 100

// The minimal shape of a PostgREST filter builder, structurally typed so this
// works with both the browser client and the service-role client.
interface Filterable {
  eq(column: string, value: unknown): this
  is(column: string, value: unknown): this
  not(column: string, op: string, value: unknown): this
  gte(column: string, value: unknown): this
  lt(column: string, value: unknown): this
  limit(n: number): this
}

/**
 * Every filter that lives on the `customers` row — the ONE definition. Applied
 * in the query (not in JS) so narrowing also shrinks what counts against
 * MAX_AUDIENCE. Excludes the per-customer day-of match, which needs the loaded
 * rows; see resolveAudience.
 */
export function applyCustomerFilters<Q extends Filterable>(q: Q, spec: AudienceSpec): Q {
  let out = q.eq('user_id', spec.userId).is('archived_at', null)

  // Kind triggers.
  if (spec.kind === 'birthday') out = out.not('birthday', 'is', null)
  if (spec.kind === 'anniversary') out = out.not('anniversary', 'is', null)
  if (spec.kind === 'win_back') {
    const days = spec.schedule.days || 45
    const cutoff = new Date(spec.today.getTime() - days * 86400000).toISOString()
    // Only customers we used to talk to and have gone quiet on — never blast a
    // brand-new, never-contacted lead.
    out = out.not('last_contacted_at', 'is', null).lt('last_contacted_at', cutoff)
  }

  // Owner-chosen audience switches.
  if (spec.audience?.not_reviewed) {
    // Never chase a review from someone who already left one or said no.
    out = out.is('reviewed_at', null).is('review_declined_at', null)
  }
  if (spec.audience?.happy_only) {
    // Only ask for a referral from someone who already rated us well.
    out = out.not('reviewed_at', 'is', null).gte('review_rating', 4)
  }
  return out
}

// `recurring_only` can't be expressed on the customers row — it's a join. Chunked
// so a full audience can't overflow the request URI.
async function narrowToRecurring<T extends { id: string }>(sb: SupabaseClient, rows: T[]): Promise<T[]> {
  if (!rows.length) return rows
  const recurring = new Set<string>()
  for (let i = 0; i < rows.length; i += IN_CHUNK) {
    const ids = rows.slice(i, i + IN_CHUNK).map(r => r.id)
    const { data } = await sb.from('job_recurrences').select('customer_id').in('customer_id', ids)
    for (const r of ((data as { customer_id: string }[]) || [])) recurring.add(r.customer_id)
  }
  return rows.filter(r => recurring.has(r.id))
}

async function loadPool(sb: SupabaseClient, spec: AudienceSpec): Promise<{ rows: AudienceCustomer[]; capped: boolean }> {
  // A stable order makes the MAX_AUDIENCE bound deterministic: without it Postgres
  // may return any 2000 rows, so the preview and the cron could slice different
  // sets and "the first 2,000" would not be a true statement.
  const base = sb.from('customers').select(AUDIENCE_SELECT)
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .limit(MAX_AUDIENCE + 1) as unknown as Filterable
  const { data, error } = await (applyCustomerFilters(base, spec) as unknown as PromiseLike<{ data: unknown; error: { message: string } | null }>)
  // supabase-js does NOT throw on a failed query — it resolves { data: null, error }.
  // Swallowing that turned any failure (renamed column, RLS change, network blip)
  // into an EMPTY audience: every campaign silently stopped sending, last_run_at
  // kept advancing, and the preview said "Reaches nobody yet" — byte-identical to
  // a genuinely empty audience. Throwing makes both callers tell the truth; the
  // preview already renders its catch, and the cron surfaces it in `notes`.
  if (error) throw new Error(`audience query failed: ${error.message}`)
  let rows = ((data as AudienceCustomer[]) || [])
  const capped = rows.length > MAX_AUDIENCE
  if (capped) rows = rows.slice(0, MAX_AUDIENCE)
  return { rows, capped }
}

/**
 * THE send-time audience: who this campaign fires at TODAY. Used by the cron.
 * Includes the per-customer day-of match for date-driven kinds.
 */
export async function resolveAudience(
  sb: SupabaseClient, spec: AudienceSpec,
): Promise<{ customers: AudienceCustomer[]; capped: boolean }> {
  const { rows, capped } = await loadPool(sb, spec)
  const leadDays = spec.schedule.lead_days || 0

  let out = rows
  if (spec.kind === 'birthday') out = out.filter(c => dateFieldFiresToday(c.birthday, spec.today, leadDays))
  else if (spec.kind === 'anniversary') out = out.filter(c => dateFieldFiresToday(c.anniversary, spec.today, leadDays))

  if (spec.audience?.recurring_only) out = await narrowToRecurring(sb, out)
  return { customers: out, capped }
}

export interface AudiencePreview {
  /** Everyone the campaign's filters select. */
  eligible: number
  /** Of those, how many at least one channel would actually reach. */
  reachable: number
  /**
   * Why the rest can't be reached. Labelled through the same describeSkip() the
   * message timeline uses, so a reason reads identically wherever it appears.
   */
  blocked: { label: string; count: number }[]
  /** A few names, so the count isn't an abstraction. */
  sample: string[]
  /** True when the audience exceeded MAX_AUDIENCE and was bounded. */
  capped: boolean
}

/**
 * The preview shown in the Campaign Manager: who this campaign is ELIGIBLE to
 * reach, and how many of them are actually contactable on the chosen channels.
 *
 * Deliberately does NOT apply today's date match. A birthday campaign fires only
 * for people whose birthday is today, so a send-time preview would read "0
 * customers" on 364 days out of 365 and tell the owner nothing. The useful
 * question before enabling is "who is this pointed at", which is the pool.
 */
export async function previewAudience(
  sb: SupabaseClient, spec: AudienceSpec, channels: string[], template: MsgType,
): Promise<AudiencePreview> {
  const { rows, capped } = await loadPool(sb, spec)
  const pool = spec.audience?.recurring_only ? await narrowToRecurring(sb, rows) : rows

  const counts = new Map<string, number>()
  let reachable = 0
  for (const c of pool) {
    const reason = blockedReason(c, channels, template)
    if (!reason) reachable++
    else {
      const label = describeSkip(reason).label
      counts.set(label, (counts.get(label) || 0) + 1)
    }
  }

  return {
    eligible: pool.length,
    reachable,
    blocked: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    sample: pool.slice(0, 3).map(c => (c.name || '').split(/\s+/)[0]).filter(Boolean),
    capped,
  }
}

// "Dana, Chris and 45 others" — the count made concrete.
export function describeSample(p: AudiencePreview): string {
  if (!p.eligible) return 'No customers match yet'
  const rest = p.eligible - p.sample.length
  const names = p.sample.join(', ')
  if (!names) return `${p.eligible} customer${p.eligible === 1 ? '' : 's'}`
  return rest > 0 ? `${names} and ${rest} other${rest === 1 ? '' : 's'}` : names
}
