import { formatCurrency, formatDate } from '@/lib/utils'

// ── THE customer/property timeline engine ────────────────────────────────────
// One chronological history, built from the tables that ALREADY hold the events.
// This is an EXTRACTION of the timeline that lived inline in customers/[id] — not a
// second history system. No new table, no event log, nothing writes here: every row
// is derived from a source of record some other engine already owns (the ledger owns
// payments, quotes own their status, job_photos owns the catalogue).
//
// Pure and I/O-free on purpose: the page fetches, this decides. That's what lets one
// engine serve a CUSTOMER timeline and a PROPERTY timeline from a single call, and
// what makes it testable in the harness without a database.
//
// Deliberately absent, in two different senses — do NOT invent tables to fill the list:
//   No such data exists: calls · files · documents · audit_log · ai_interactions ·
//   videos (job_photos is photos) · schedule-change history (jobs.scheduled_date
//   mutates with no record of the previous date).
//   Exists but excluded by the owner: technician assignment and time_entries
//   (clock in/out per technician per job). `technicians`/`crews`/`time_entries` are
//   real and currently empty — dispatch is still being built alongside this. When
//   that work lands and the owner wants shifts in the history, add a source here;
//   don't grow a second timeline around it.

export type TimelineKind =
  | 'lead' | 'quote_created' | 'quote_sent' | 'followup' | 'quote_accepted' | 'quote_declined'
  | 'job_scheduled' | 'job_completed' | 'invoice_created' | 'invoice_viewed' | 'invoice_paid'
  | 'message_in' | 'message_out' | 'note' | 'payment' | 'credit' | 'refund' | 'expense'
  | 'photo' | 'measurement' | 'price_change' | 'consent' | 'automation' | 'portal_request'

// Coarse buckets for filtering. Every kind belongs to exactly one group.
export type TimelineGroup = 'sales' | 'work' | 'money' | 'comms' | 'record'

export const KIND_GROUP: Record<TimelineKind, TimelineGroup> = {
  lead: 'sales', quote_created: 'sales', quote_sent: 'sales', followup: 'sales',
  quote_accepted: 'sales', quote_declined: 'sales',
  job_scheduled: 'work', job_completed: 'work', photo: 'work', measurement: 'work',
  invoice_created: 'money', invoice_viewed: 'money', invoice_paid: 'money',
  payment: 'money', credit: 'money', refund: 'money', expense: 'money', price_change: 'money',
  message_in: 'comms', message_out: 'comms', automation: 'comms', portal_request: 'comms',
  note: 'record', consent: 'record',
}

export const GROUP_LABELS: Record<TimelineGroup, string> = {
  sales: 'Sales', work: 'Work', money: 'Money', comms: 'Messages', record: 'Record',
}

export const TIMELINE_GROUPS = ['sales', 'work', 'money', 'comms', 'record'] as const

export interface TimelineEvent {
  at: string
  kind: TimelineKind
  title: string
  sub?: string
  href?: string
  /** Resolved image URL — the caller maps storage_path via lib/photos, so this stays I/O-free. */
  thumb?: string
  /** Scopes an event to one property, so the same engine can render a property timeline. */
  propertyId?: string | null
}

// Every source is optional: a caller that hasn't fetched something gets a timeline
// without it rather than a crash — which is what lets the property view pass a subset.
export interface TimelineSources {
  gstPercent?: number | null
  /** When present, comms events deep-link into THE conversation (?c=) instead of the bare inbox. */
  customerId?: string
  quotes?: TlQuote[]
  jobs?: TlJob[]
  invoices?: TlInvoice[]
  messages?: TlMessage[]
  payments?: TlPayment[]
  serviceRequests?: TlServiceRequest[]
  photos?: TlPhoto[]
  measurements?: TlMeasurement[]
  expenses?: TlExpense[]
  consentChanges?: TlConsentChange[]
  priceChanges?: TlPriceChange[]
  campaignLog?: TlCampaignLog[]
}

export interface TlQuote { id: string; quote_number: string; service_type?: string | null; total?: number | null; status: string; created_at: string; updated_at: string; sent_at?: string | null; last_followed_up_at?: string | null; follow_up_count?: number | null; property_id?: string | null }
/** `recurrence_id` is what lets one booking of a series read as one event rather
 *  than 25 — see the jobs section of buildTimeline. */
export interface TlJob { id: string; title?: string | null; scheduled_date: string; status: string; created_at: string; updated_at: string; completed_at?: string | null; actual_minutes?: number | null; property_id?: string | null; recurrence_id?: string | null }
export interface TlInvoice { id: string; invoice_number: string; amount?: number | null; status: string; created_at: string; updated_at: string; paid_at?: string | null; viewed_at?: string | null; property_id?: string | null }
export interface TlMessage { direction: string; channel: string; body: string | null; created_at: string }
export interface TlPayment { amount: number; status: string; kind: string; method: string | null; notes: string | null; created_at: string }
export interface TlServiceRequest { message: string; created_at: string }
/** `url` is resolved by the caller from storage_path (lib/photos owns that mapping). */
export interface TlPhoto { id: string; url: string; kind?: string | null; caption?: string | null; taken_at?: string | null; created_at?: string | null; property_id?: string | null; job_id?: string | null }
export interface TlMeasurement { id: string; created_at: string; property_id?: string | null; accepted_sqft?: number | null; auto_sqft?: number | null; source?: string | null; adjusted?: boolean | null }
/** `category` is the resolved expense_categories.name; expenses link by job_id ONLY. */
export interface TlExpense { id: string; description?: string | null; amount?: number | null; category?: string | null; spent_at?: string | null; created_at: string; job_id?: string | null }
export interface TlConsentChange { id: string; channel: string; old_value?: boolean | null; new_value?: boolean | null; source?: string | null; created_at: string }
export interface TlPriceChange { id: string; old_amount?: number | null; new_amount?: number | null; reason?: string | null; scope?: string | null; created_at: string; job_id?: string | null }
/** `campaign_name`/`campaign_kind` come from the crm_campaigns join the caller does. */
export interface TlCampaignLog { id: string; campaign_name?: string | null; campaign_kind?: string | null; channel?: string | null; status?: string | null; detail?: string | null; created_at: string }

const WON = new Set(['accepted', 'scheduled', 'completed', 'paid'])
const money = (n: unknown) => formatCurrency(Number(n) || 0)
const clip = (s: string | null | undefined, n: number) => (s || '').trim().slice(0, n)
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ') || undefined

export function buildTimeline(s: TimelineSources): TimelineEvent[] {
  // GST-inclusive invoice amounts, so the timeline agrees with the Invoices page and
  // the portal. Same multiplier the ledger uses — this never re-derives a total.
  const gstMult = 1 + (Number(s.gstPercent) || 0) / 100
  const gross = (amount: unknown) => Math.round((Number(amount) || 0) * gstMult * 100) / 100
  const out: TimelineEvent[] = []

  // Expenses and price changes are keyed by job_id only, and a photo may carry one
  // instead of a property_id — but the job already knows its address. Without this
  // hop those events have no property and vanish from a property timeline, even
  // though they plainly happened there. Empty when the caller passed no jobs, which
  // just means those events stay customer-level.
  const jobToProperty = new Map<string, string | null>()
  for (const j of s.jobs || []) jobToProperty.set(j.id, j.property_id ?? null)
  const jobProperty = (jobId: string | null | undefined) => (jobId ? jobToProperty.get(jobId) ?? null : null)

  for (const q of s.quotes || []) {
    const href = `/dashboard/quotes/${q.id}`
    const pid = q.property_id
    out.push({ at: q.created_at, kind: 'quote_created', title: `Quote ${q.quote_number} created`, sub: join(q.service_type, money(q.total)), href, propertyId: pid })
    if (q.sent_at) out.push({ at: q.sent_at, kind: 'quote_sent', title: `Quote ${q.quote_number} sent`, href, propertyId: pid })
    if (q.last_followed_up_at) out.push({ at: q.last_followed_up_at, kind: 'followup', title: `Followed up on ${q.quote_number}`, sub: `${q.follow_up_count ?? 0} total`, href, propertyId: pid })
    // quotes has no accepted_at/declined_at — updated_at is the only timestamp there is.
    if (WON.has(q.status)) out.push({ at: q.updated_at, kind: 'quote_accepted', title: `Quote ${q.quote_number} accepted`, sub: money(q.total), href, propertyId: pid })
    // A declined quote used to just stop appearing — losing the sale left no trace.
    if (q.status === 'declined') out.push({ at: q.updated_at, kind: 'quote_declined', title: `Quote ${q.quote_number} declined`, sub: money(q.total), href, propertyId: pid })
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────
  // ONE OPERATOR ACTION IS ONE EVENT. Booking a recurring plan writes the whole
  // series at once — 25 rows sharing a recurrence_id and a created_at to the
  // microsecond — and a row-per-job timeline rendered that as 25 identical
  // "Job scheduled — Weekly Mowing" entries, all on the same date. It buried the
  // quote, the messages and the payments under the customer's own subscription,
  // for exactly the recurring customers the business is built on (measured: 6
  // customers with 18–25 such rows each).
  //
  // So `job_scheduled` collapses per (recurrence_id + created_at + property):
  //   • recurrence_id — a one-off job has none and is never collapsed
  //   • created_at — a later top-up of the SAME series is a separate action and
  //     stays a separate event, which is the honest reading
  //   • property — the cluster carries one propertyId or timelineForProperty
  //     could not scope it; a series split across addresses stays split
  //
  // COMPLETIONS ARE NEVER COLLAPSED: each visit is a real thing that happened on
  // its own day. Only the booking is one act.
  const scheduleClusters = new Map<string, { at: string; name: string; recurrenceId: string; propertyId: string | null; dates: string[] }>()
  for (const j of s.jobs || []) {
    const name = j.title || 'Visit'
    if (j.recurrence_id) {
      const key = `${j.recurrence_id}|${j.created_at}|${j.property_id ?? ''}`
      const cluster = scheduleClusters.get(key)
      if (cluster) cluster.dates.push(j.scheduled_date)
      else scheduleClusters.set(key, { at: j.created_at, name, recurrenceId: j.recurrence_id, propertyId: j.property_id ?? null, dates: [j.scheduled_date] })
    } else {
      out.push({ at: j.created_at, kind: 'job_scheduled', title: `Job scheduled — ${name}`, sub: `for ${formatDate(j.scheduled_date)}`, propertyId: j.property_id })
    }
    if (j.status === 'completed') {
      // completed_at, NOT updated_at: editing a finished job's notes months later
      // used to drag "Job completed" to today and reorder the whole history.
      const mins = Number(j.actual_minutes) || 0
      out.push({ at: j.completed_at || j.updated_at, kind: 'job_completed', title: `Job completed — ${name}`, sub: mins > 0 ? `${mins} min on site` : undefined, propertyId: j.property_id })
    }
  }
  for (const c of scheduleClusters.values()) {
    const dates = c.dates.slice().sort()
    const n = dates.length
    // A series of one reads as a plain booking — "1 visit scheduled" is a worse
    // sentence than the one it replaced.
    const title = n === 1 ? `Job scheduled — ${c.name}` : `${n} visits scheduled — ${c.name}`
    const span = n === 1 ? `for ${formatDate(dates[0])}` : `${formatDate(dates[0])} → ${formatDate(dates[n - 1])}`
    out.push({
      at: c.at, kind: 'job_scheduled', title, sub: span, propertyId: c.propertyId,
      // The series is a real destination — the same focus link the property card uses.
      href: `/dashboard/schedule?focus=${c.recurrenceId}`,
    })
  }

  for (const inv of s.invoices || []) {
    const href = `/dashboard/invoices?invoice=${encodeURIComponent(inv.invoice_number)}`
    const pid = inv.property_id
    out.push({ at: inv.created_at, kind: 'invoice_created', title: `Invoice ${inv.invoice_number} created`, sub: money(gross(inv.amount)), href, propertyId: pid })
    // The customer opening their invoice is already recorded; it was never surfaced.
    if (inv.viewed_at) out.push({ at: inv.viewed_at, kind: 'invoice_viewed', title: `${inv.invoice_number} opened by the customer`, href, propertyId: pid })
    // paid_at for the same reason as completed_at above.
    if (inv.status === 'paid') out.push({ at: inv.paid_at || inv.updated_at, kind: 'invoice_paid', title: `Invoice ${inv.invoice_number} paid`, sub: money(gross(inv.amount)), href, propertyId: pid })
  }

  // With a customerId, a comms event opens THE conversation, not the bare inbox.
  const msgHref = s.customerId ? `/dashboard/messages?c=${s.customerId}` : '/dashboard/messages'
  for (const m of s.messages || []) {
    // Internal notes ARE history. They were skipped entirely, so the one place an
    // owner writes down what happened never appeared in what happened.
    if (m.direction === 'internal') {
      out.push({ at: m.created_at, kind: 'note', title: 'Internal note', sub: clip(m.body, 140), href: msgHref })
      continue
    }
    const inbound = m.direction === 'inbound'
    const chan = m.channel === 'email' ? 'email' : m.channel === 'portal' ? 'portal message' : 'SMS'
    out.push({ at: m.created_at, kind: inbound ? 'message_in' : 'message_out', title: `${inbound ? 'Received' : 'Sent'} ${chan}`, sub: clip(m.body, 90), href: msgHref })
  }

  // The ledger holds payments AND credit movements (kind='credit') AND reversals
  // (negative amounts). They all wore one "payment" icon; they're distinct money
  // events and now read as such.
  for (const p of s.payments || []) {
    if (p.status !== 'paid') continue
    const amt = Number(p.amount) || 0
    if (p.kind === 'credit') {
      out.push({ at: p.created_at, kind: 'credit', title: `${amt >= 0 ? 'Credit added' : 'Credit applied'} · ${money(Math.abs(amt))}`, sub: p.notes || undefined })
    } else if (amt < 0) {
      out.push({ at: p.created_at, kind: 'refund', title: `Refund · ${money(Math.abs(amt))}`, sub: p.notes || undefined })
    } else {
      out.push({ at: p.created_at, kind: 'payment', title: 'Payment received', sub: `${money(amt)}${p.method && p.method !== 'stripe' ? ` · ${p.method}` : ''}` })
    }
  }

  for (const sr of s.serviceRequests || []) {
    const msg = sr.message || ''
    const isLead = /^new .* lead/i.test(msg)
    // Strip the "New Website lead — " prefix so the sub isn't redundant with the title.
    const sub = isLead ? msg.replace(/^new\b.*?\blead\b\s*[—-]?\s*/i, '').slice(0, 160) : msg.slice(0, 160)
    out.push({ at: sr.created_at, kind: isLead ? 'lead' : 'portal_request', title: isLead ? 'Website lead' : 'Portal service request', sub, href: msgHref })
  }

  // Photos carry their own kind (before/after/general) — a visit's evidence.
  for (const ph of s.photos || []) {
    const k = (ph.kind || '').toLowerCase()
    const label = k === 'before' ? 'Before photo' : k === 'after' ? 'After photo' : 'Photo added'
    const at = ph.taken_at || ph.created_at
    if (!at) continue
    out.push({ at, kind: 'photo', title: label, sub: ph.caption || undefined, thumb: ph.url, propertyId: ph.property_id ?? jobProperty(ph.job_id) })
  }

  for (const mm of s.measurements || []) {
    // accepted_sqft is what the owner actually agreed to; auto_sqft is what the tool
    // proposed. Show the accepted figure, and say when it was hand-adjusted.
    const sq = Number(mm.accepted_sqft) || Number(mm.auto_sqft) || 0
    out.push({
      at: mm.created_at, kind: 'measurement', title: 'Property measured',
      sub: join(sq > 0 && `${Math.round(sq).toLocaleString()} ft²`, mm.adjusted ? 'adjusted by hand' : mm.source),
      propertyId: mm.property_id,
    })
  }

  // expenses link by job_id ONLY — the caller resolves them to this customer by
  // joining through their jobs. spent_at is the business date; created_at is just
  // when it got typed in.
  for (const e of s.expenses || []) {
    out.push({ at: e.spent_at || e.created_at, kind: 'expense', title: `Expense · ${money(e.amount)}`, sub: join(e.description, e.category), propertyId: jobProperty(e.job_id) })
  }

  for (const c of s.consentChanges || []) {
    const on = !!c.new_value
    out.push({
      at: c.created_at, kind: 'consent',
      title: `${(c.channel || '').toUpperCase()} ${on ? 'opted in' : 'opted out'}`,
      sub: join(`${c.old_value ? 'on' : 'off'} → ${on ? 'on' : 'off'}`, c.source),
    })
  }

  for (const pc of s.priceChanges || []) {
    out.push({
      at: pc.created_at, kind: 'price_change',
      title: `Price changed · ${money(pc.old_amount)} → ${money(pc.new_amount)}`,
      sub: join(pc.scope, pc.reason),
      propertyId: jobProperty(pc.job_id),
    })
  }

  for (const cl of s.campaignLog || []) {
    out.push({
      at: cl.created_at, kind: 'automation',
      title: `Automation · ${cl.campaign_name || cl.campaign_kind || 'campaign'}`,
      sub: join(cl.channel, cl.status, cl.detail),
    })
  }

  return sortTimeline(out)
}

// Newest first. Rows with an unparseable date sink to the bottom rather than
// landing at 1970 and pretending to be the oldest thing that ever happened.
export function sortTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return events.slice().sort((a, b) => {
    const ta = new Date(a.at).getTime(), tb = new Date(b.at).getTime()
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
    if (Number.isNaN(ta)) return 1
    if (Number.isNaN(tb)) return -1
    return tb - ta
  })
}

// Narrow a built timeline to one property. Events with no propertyId are
// customer-level (a payment isn't "at" an address) and are excluded rather than
// repeated under every address the customer owns.
export function timelineForProperty(events: TimelineEvent[], propertyId: string): TimelineEvent[] {
  return events.filter(e => e.propertyId === propertyId)
}

// Free-text search over what the row actually shows.
export function searchTimeline(events: TimelineEvent[], q: string): TimelineEvent[] {
  const term = q.trim().toLowerCase()
  if (!term) return events
  return events.filter(e => e.title.toLowerCase().includes(term) || (e.sub || '').toLowerCase().includes(term))
}

// Filter by group. An empty/absent set means "everything" — a filter nobody set
// must never hide history.
export function filterTimeline(events: TimelineEvent[], groups?: Set<TimelineGroup> | null): TimelineEvent[] {
  if (!groups || groups.size === 0) return events
  return events.filter(e => groups.has(KIND_GROUP[e.kind]))
}

// How many events each group holds — so filter chips can show counts and a chip
// with nothing behind it can be hidden.
export function timelineGroupCounts(events: TimelineEvent[]): Record<TimelineGroup, number> {
  const out: Record<TimelineGroup, number> = { sales: 0, work: 0, money: 0, comms: 0, record: 0 }
  for (const e of events) out[KIND_GROUP[e.kind]]++
  return out
}

// Calendar-month buckets, preserving the incoming order (already newest-first).
export function groupTimelineByMonth(events: TimelineEvent[]): { label: string; events: TimelineEvent[] }[] {
  const out: { label: string; events: TimelineEvent[] }[] = []
  for (const e of events) {
    const d = new Date(e.at)
    const label = Number.isNaN(d.getTime()) ? 'Earlier' : d.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
    const last = out[out.length - 1]
    if (last && last.label === label) last.events.push(e)
    else out.push({ label, events: [e] })
  }
  return out
}
