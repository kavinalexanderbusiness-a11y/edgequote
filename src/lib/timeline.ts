import type { SupabaseClient } from '@supabase/supabase-js'
import type { Customer, Invoice, Job, Quote } from '@/types'
import { formatCurrency, formatDate } from '@/lib/utils'
import { DAY_STATUS_META, type DayStatus } from '@/lib/dayStatus'
import {
  FileText, Send, RotateCw, CheckCircle2, CalendarPlus, Wrench, Receipt, DollarSign,
  MessageSquare, StickyNote, UserPlus, Star, StarOff, Globe, Gift, Eye, Camera,
  Megaphone, Tag, CloudRain,
} from 'lucide-react'

// ── THE timeline engine ─────────────────────────────────────────────────────────
// One place that turns EdgeQuote's records into a chronological activity feed.
// Extracted from customers/[id] (which had the original inline version) so the
// Customer Hub and the Property page render the SAME history the same way.
//
// Two halves, so nothing is fetched twice:
//   • eventsFrom*(rows)      — pure builders for rows the page ALREADY loads
//                              (quotes / jobs / invoices / the customer row).
//   • fetchTimelineExtras()  — loads + builds everything else (messages, payments,
//                              portal requests, reviews come from the customer row,
//                              website leads, referrals, AI Vision analyses, photos,
//                              campaign sends, price changes, weather disruptions).
// Every query degrades gracefully (a missing table just contributes no events).

export type TimelineKind =
  | 'customer_added'
  | 'quote_created' | 'quote_sent' | 'followup' | 'quote_accepted'
  | 'job_scheduled' | 'job_completed'
  | 'invoice_created' | 'invoice_paid'
  | 'message_in' | 'message_out' | 'payment' | 'portal_request'
  | 'review_requested' | 'reviewed' | 'review_declined'
  | 'website_lead' | 'referral'
  | 'vision' | 'photos' | 'campaign' | 'price_change' | 'weather_delay'

export interface TimelineEvent {
  at: string
  kind: TimelineKind
  title: string
  sub?: string
  href?: string
}

export const EVENT_META: Record<TimelineKind, { icon: typeof FileText; color: string }> = {
  customer_added:  { icon: UserPlus,     color: 'text-ink-muted bg-surface border-border' },
  quote_created:   { icon: FileText,     color: 'text-ink-muted bg-surface border-border' },
  quote_sent:      { icon: Send,         color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  followup:        { icon: RotateCw,     color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  quote_accepted:  { icon: CheckCircle2, color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  job_scheduled:   { icon: CalendarPlus, color: 'text-accent bg-accent/10 border-accent/20' },
  job_completed:   { icon: Wrench,       color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  invoice_created: { icon: Receipt,      color: 'text-ink-muted bg-surface border-border' },
  invoice_paid:    { icon: DollarSign,   color: 'text-accent bg-accent/10 border-accent/20' },
  message_in:      { icon: MessageSquare,color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  message_out:     { icon: Send,         color: 'text-ink-muted bg-surface border-border' },
  payment:         { icon: DollarSign,   color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  portal_request:  { icon: StickyNote,   color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  review_requested:{ icon: Star,         color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  reviewed:        { icon: Star,         color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  review_declined: { icon: StarOff,      color: 'text-ink-muted bg-surface border-border' },
  website_lead:    { icon: Globe,        color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  referral:        { icon: Gift,         color: 'text-accent bg-accent/10 border-accent/20' },
  vision:          { icon: Eye,          color: 'text-accent bg-accent/10 border-accent/20' },
  photos:          { icon: Camera,       color: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
  campaign:        { icon: Megaphone,    color: 'text-ink-muted bg-surface border-border' },
  price_change:    { icon: Tag,          color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  weather_delay:   { icon: CloudRain,    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
}

const WON = new Set(['accepted', 'scheduled', 'completed', 'paid'])

export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

// ── Pure builders (rows the page already has) ──────────────────────────────────

export function eventsFromQuotes(quotes: Quote[]): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const q of quotes) {
    events.push({ at: q.created_at, kind: 'quote_created', title: `Quote ${q.quote_number} created`, sub: `${q.service_type} · ${formatCurrency(Number(q.total))}`, href: `/dashboard/quotes/${q.id}` })
    if (q.sent_at) events.push({ at: q.sent_at, kind: 'quote_sent', title: `Quote ${q.quote_number} sent`, href: `/dashboard/quotes/${q.id}` })
    if (q.last_followed_up_at) events.push({ at: q.last_followed_up_at, kind: 'followup', title: `Followed up on ${q.quote_number}`, sub: `${q.follow_up_count} total`, href: `/dashboard/quotes/${q.id}` })
    if (WON.has(q.status)) events.push({ at: q.updated_at, kind: 'quote_accepted', title: `Quote ${q.quote_number} accepted`, sub: formatCurrency(Number(q.total)), href: `/dashboard/quotes/${q.id}` })
  }
  return events
}

export function eventsFromJobs(jobs: Job[]): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const j of jobs) {
    const href = j.recurrence_id ? `/dashboard/schedule?focus=${j.recurrence_id}` : undefined
    events.push({ at: j.created_at, kind: 'job_scheduled', title: `Job scheduled — ${j.title}`, sub: `for ${formatDate(j.scheduled_date)}`, href })
    if (j.status === 'completed') events.push({ at: j.completed_at || j.updated_at, kind: 'job_completed', title: `Job completed — ${j.title}`, sub: j.actual_minutes ? `${j.actual_minutes} min on site` : undefined, href })
  }
  return events
}

export function eventsFromInvoices(invoices: Invoice[]): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const inv of invoices) {
    events.push({ at: inv.created_at, kind: 'invoice_created', title: `Invoice ${inv.invoice_number} created`, sub: formatCurrency(Number(inv.amount)), href: '/dashboard/invoices' })
    if (inv.status === 'paid') events.push({ at: inv.paid_at || inv.updated_at, kind: 'invoice_paid', title: `Invoice ${inv.invoice_number} paid`, sub: formatCurrency(Number(inv.amount)), href: '/dashboard/invoices' })
  }
  return events
}

// The customer's own lifecycle: when they were added + the review journey
// (columns live on the customers row — no extra fetch).
export function eventsFromCustomer(c: Customer): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { at: c.created_at, kind: 'customer_added', title: 'Customer added', sub: c.acquisition_source ? `via ${c.acquisition_source}` : undefined },
  ]
  if (c.review_requested_at) events.push({ at: c.review_requested_at, kind: 'review_requested', title: 'Review requested' })
  if (c.reviewed_at) events.push({ at: c.reviewed_at, kind: 'reviewed', title: 'Left a review', sub: [c.review_rating ? `${c.review_rating}★` : null, c.review_source].filter(Boolean).join(' · ') || undefined })
  if (c.review_declined_at) events.push({ at: c.review_declined_at, kind: 'review_declined', title: 'Declined to review' })
  return events
}

// ── Fetched extras (everything the page doesn't already load) ──────────────────

export interface TimelineScope {
  // Exactly one of these drives the fetch scope:
  customerId?: string
  propertyId?: string
  // Context the caller already has (used for joins — never re-fetched):
  jobs?: Pick<Job, 'id' | 'title' | 'scheduled_date' | 'property_id'>[]
  properties?: { id: string; address: string }[]
}

function addr(scope: TimelineScope, propertyId: string | null): string | null {
  if (!propertyId) return null
  return scope.properties?.find(p => p.id === propertyId)?.address ?? null
}

const CAMPAIGN_LABELS: Record<string, string> = {
  birthday: 'Birthday message', anniversary: 'Anniversary message',
  win_back: 'Win-back message', broadcast: 'Broadcast message',
}

// Load + build every additional timeline source for a customer or a property.
// One round of parallel queries; each source degrades to [] on any error.
export async function fetchTimelineExtras(supabase: SupabaseClient, scope: TimelineScope): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = []
  const jobIds = (scope.jobs || []).map(j => j.id).slice(0, 300)
  const jobDates = Array.from(new Set((scope.jobs || []).map(j => j.scheduled_date))).slice(0, 300)

  const [msgs, pays, reqs, leads, refs, vision, photos, camps, priceChanges, dayStatuses] = await Promise.all([
    // Customer-scoped comms (messages have no property link).
    scope.customerId
      ? supabase.from('messages').select('direction, channel, body, created_at').eq('customer_id', scope.customerId).order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: null }),
    scope.customerId
      ? supabase.from('payments').select('amount, status, created_at, paid_at').eq('customer_id', scope.customerId)
      : Promise.resolve({ data: null }),
    scope.customerId
      ? supabase.from('service_requests').select('message, created_at').eq('customer_id', scope.customerId)
      : Promise.resolve({ data: null }),
    scope.customerId
      ? supabase.from('website_leads').select('submitted_at, created_at, requested_services, status').eq('customer_id', scope.customerId)
      : Promise.resolve({ data: null }),
    scope.customerId
      ? supabase.from('referrals').select('created_at, joined_at, rewarded_at, status, referred_name, referrer_customer_id, referred_customer_id').or(`referrer_customer_id.eq.${scope.customerId},referred_customer_id.eq.${scope.customerId}`)
      : Promise.resolve({ data: null }),
    // Property-aware sources (work in both scopes).
    (scope.propertyId
      ? supabase.from('property_intelligence').select('created_at, property_id, confidence, image_count').eq('property_id', scope.propertyId)
      : supabase.from('property_intelligence').select('created_at, property_id, confidence, image_count').eq('customer_id', scope.customerId!)),
    (scope.propertyId
      ? supabase.from('job_photos').select('created_at, taken_at, kind, job_id, property_id').eq('property_id', scope.propertyId)
      : supabase.from('job_photos').select('created_at, taken_at, kind, job_id, property_id').eq('customer_id', scope.customerId!)),
    scope.customerId
      ? supabase.from('crm_campaign_log').select('created_at, crm_campaigns(kind)').eq('customer_id', scope.customerId)
      : Promise.resolve({ data: null }),
    jobIds.length
      ? supabase.from('job_price_changes').select('created_at, old_amount, new_amount, reason, job_id').in('job_id', jobIds)
      : Promise.resolve({ data: null }),
    jobDates.length
      ? supabase.from('day_statuses').select('date, status, blocks').in('date', jobDates)
      : Promise.resolve({ data: null }),
  ])

  // Messages (SMS / email / portal) — internal notes stay in the notes card.
  for (const m of (msgs.data as { direction: string; channel: string; body: string | null; created_at: string }[]) || []) {
    if (m.direction === 'internal') continue
    const inbound = m.direction === 'inbound'
    const chan = m.channel === 'email' ? 'email' : m.channel === 'portal' ? 'portal message' : 'SMS'
    events.push({ at: m.created_at, kind: inbound ? 'message_in' : 'message_out', title: `${inbound ? 'Received' : 'Sent'} ${chan}`, sub: (m.body || '').slice(0, 90), href: scope.customerId ? `/dashboard/messages?customer=${scope.customerId}` : '/dashboard/messages' })
  }
  // Payments received.
  for (const p of (pays.data as { amount: number; status: string; created_at: string; paid_at: string | null }[]) || []) {
    if (p.status === 'paid') events.push({ at: p.paid_at || p.created_at, kind: 'payment', title: 'Payment received', sub: formatCurrency(Number(p.amount)), href: '/dashboard/invoices' })
  }
  // Portal service requests.
  for (const sr of (reqs.data as { message: string; created_at: string }[]) || []) {
    events.push({ at: sr.created_at, kind: 'portal_request', title: 'Portal service request', sub: (sr.message || '').slice(0, 90), href: scope.customerId ? `/dashboard/messages?customer=${scope.customerId}` : '/dashboard/messages' })
  }
  // Website leads.
  for (const l of (leads.data as { submitted_at: string | null; created_at: string; requested_services: string | null; status: string }[]) || []) {
    events.push({ at: l.submitted_at || l.created_at, kind: 'website_lead', title: 'Website lead submitted', sub: l.requested_services || undefined, href: '/dashboard/messages' })
  }
  // Referrals — both directions (they referred someone / they were referred).
  for (const r of (refs.data as { created_at: string; joined_at: string | null; rewarded_at: string | null; status: string; referred_name: string | null; referrer_customer_id: string; referred_customer_id: string | null }[]) || []) {
    const isReferrer = r.referrer_customer_id === scope.customerId
    const who = r.referred_name || 'a neighbour'
    const title = isReferrer
      ? (r.status === 'joined' || r.status === 'rewarded' ? `Referral joined — ${who}` : `Referred ${who}`)
      : 'Joined from a referral'
    const href = isReferrer && r.referred_customer_id ? `/dashboard/customers/${r.referred_customer_id}` : undefined
    events.push({ at: r.joined_at || r.rewarded_at || r.created_at, kind: 'referral', title, sub: r.status === 'rewarded' ? 'Reward given' : undefined, href })
  }
  // AI Vision analyses.
  for (const v of (vision.data as { created_at: string; property_id: string; confidence: number | null; image_count: number }[]) || []) {
    const a = addr(scope, v.property_id)
    events.push({ at: v.created_at, kind: 'vision', title: `AI Vision analyzed ${a || 'the property'}`, sub: v.confidence != null ? `confidence ${Math.round(v.confidence)}/100 · ${v.image_count} image${v.image_count === 1 ? '' : 's'}` : undefined, href: `/dashboard/grow/vision?property=${v.property_id}` })
  }
  // Photos — grouped per job (or per day when unattached) so 6 uploads = 1 event.
  const photoRows = (photos.data as { created_at: string; taken_at: string | null; kind: string; job_id: string | null; property_id: string | null }[]) || []
  const photoGroups = new Map<string, { at: string; count: number; kinds: Set<string>; property_id: string | null }>()
  for (const ph of photoRows) {
    const key = ph.job_id || (ph.taken_at || ph.created_at).slice(0, 10)
    const g = photoGroups.get(key) || { at: ph.taken_at || ph.created_at, count: 0, kinds: new Set<string>(), property_id: ph.property_id }
    g.count += 1
    g.kinds.add(ph.kind)
    if ((ph.taken_at || ph.created_at) > g.at) g.at = ph.taken_at || ph.created_at
    photoGroups.set(key, g)
  }
  for (const g of photoGroups.values()) {
    const pair = g.kinds.has('before') && g.kinds.has('after')
    events.push({ at: g.at, kind: 'photos', title: `${g.count} photo${g.count === 1 ? '' : 's'} added${pair ? ' (before & after)' : ''}`, sub: addr(scope, g.property_id) || undefined, href: g.property_id ? `/dashboard/properties/${g.property_id}` : undefined })
  }
  // CRM campaign sends (birthday / anniversary / win-back / broadcast).
  for (const cl of (camps.data as { created_at: string; crm_campaigns: { kind: string } | { kind: string }[] | null }[]) || []) {
    const kind = Array.isArray(cl.crm_campaigns) ? cl.crm_campaigns[0]?.kind : cl.crm_campaigns?.kind
    events.push({ at: cl.created_at, kind: 'campaign', title: CAMPAIGN_LABELS[kind || ''] || 'Campaign message sent', href: scope.customerId ? `/dashboard/messages?customer=${scope.customerId}` : '/dashboard/messages' })
  }
  // Price changes (audit trail).
  const jobTitle = (jobId: string | null) => (scope.jobs || []).find(j => j.id === jobId)?.title
  for (const pc of (priceChanges.data as { created_at: string; old_amount: number | null; new_amount: number | null; reason: string | null; job_id: string | null }[]) || []) {
    const from = pc.old_amount != null ? formatCurrency(Number(pc.old_amount)) : '—'
    const to = pc.new_amount != null ? formatCurrency(Number(pc.new_amount)) : '—'
    events.push({ at: pc.created_at, kind: 'price_change', title: `Price changed ${from} → ${to}`, sub: [jobTitle(pc.job_id), pc.reason].filter(Boolean).join(' · ') || undefined })
  }
  // Weather / schedule disruptions — a blocked day that had this scope's visits on it.
  for (const d of (dayStatuses.data as { date: string; status: DayStatus; blocks: boolean }[]) || []) {
    if (!d.blocks) continue
    const affected = (scope.jobs || []).filter(j => j.scheduled_date === d.date)
    if (!affected.length) continue
    const meta = DAY_STATUS_META[d.status]
    events.push({ at: `${d.date}T12:00:00`, kind: 'weather_delay', title: `${meta?.label || 'Day blocked'} — schedule disrupted`, sub: `${affected.length} visit${affected.length === 1 ? '' : 's'} affected`, href: '/dashboard/schedule' })
  }

  return events
}
