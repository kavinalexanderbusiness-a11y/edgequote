import type { SupabaseClient } from '@supabase/supabase-js'
import { modelForTier, type AiTier } from '@/lib/ai/anthropic'
import { getPropertyContext, propertyContextBlock } from '@/lib/ai/propertyContext'
import { loadBusinessContext, contextLine, type BusinessContext } from '@/lib/marketing/businessContext'
import { MSG_VARIABLES } from '@/lib/comms/templates'
import { serviceKey, serviceLabel } from '@/lib/labor'
import { isQuoteExpired } from '@/lib/quoteStatus'

// ── The AI assist engine ──────────────────────────────────────────────────────
// Server-only. ONE task registry for every in-app writing/summarizing assist:
// message drafts, customer summaries, review replies, quote scopes, job notes.
// Each task gathers its own context HERE, from the database, scoped to the
// signed-in user — the client sends only ids and free text, never facts. The
// model is an assistant, not a source of truth: every prompt forbids inventing
// prices, dates, or history, and everything it writes lands in an editable
// field that the owner sends/saves through the existing (consent-gated) paths.
//
// Quality principles (owner directive 2026-07-15):
// • Numbers are computed in CODE and handed to the model as facts — the model
//   never does arithmetic over raw rows (lifetime revenue, balances, gaps).
// • Context includes what actually helps a draft: the live conversation thread
//   (reply-aware), the next scheduled visit, the linked job, the property.
// • One shared voice (STYLE) + one shared safety block (GUARDRAILS) so every
//   tool writes like the same person and none of them invent or leak facts.
//
// Generation itself goes through the EXISTING text gateway
// (lib/ai/studioGateway.streamText) — this file only builds inputs. Disabled-by-
// default and deterministic fallbacks are inherited from that gateway.

export type AssistTask =
  | 'draft_message'      // email/SMS writer (composer draft or rewrite)
  | 'customer_summary'   // owner-facing customer brief
  | 'review_response'    // public reply to a received review
  | 'quote_scope'        // scope-of-work notes for a quote
  | 'job_notes'          // clean up crew jottings into professional notes
  | 'quote_intelligence' // owner-facing analysis of one quote (advisory; never prices)

export interface AssistPayload {
  task: AssistTask
  customerId?: string
  // draft_message
  template?: string        // MsgType key — the intent of the message
  channels?: string[]      // ['sms','email'] — drives length/format guidance
  currentText?: string     // existing draft (rewrite) or '' (write fresh)
  instruction?: string     // optional owner hint ("mention the gate was locked")
  bulk?: boolean           // going to many people — no personal specifics
  jobId?: string           // linked visit — fetched server-side for real facts
  vars?: { dateLabel?: string; timeWindow?: string; address?: string; amount?: string }
  // review_response
  rating?: number
  source?: string
  // quote_scope
  propertyId?: string
  serviceType?: string
  services?: Array<{ name?: string; notes?: string }>  // labels only, no prices
  measuredSqft?: number
  address?: string
  // job_notes / quote_scope free text
  draft?: string
  // quote_intelligence
  quoteId?: string
  focus?: 'full' | 'pricing' | 'upsells' | 'gaps' | 'time' | 'risk'
}

export interface AssistInput {
  system: string
  prompt: string
  maxTokens: number
  model: string
}

// ── Shared voice + safety ─────────────────────────────────────────────────────
// ONE style block so the AI brief, the composer, the review reply and the quote
// all sound like the same person: a competent local contractor, not a bot.
const STYLE = `Voice: a competent, friendly local contractor writing in their own words. Plain everyday language, short sentences, specific over vague. Warm but never gushing; confident but never salesy. Contractions are fine. No corporate filler ("we strive", "valued customer", "please don't hesitate"), no exclamation marks unless genuinely celebratory, no emoji unless the existing text already uses them.`

// ── Which trade is this? ──────────────────────────────────────────────────────
// ONE shared block, alongside STYLE and GUARDRAILS, because every task had the same
// hole: the prompts quietly assumed lawn care ("your lawn", "Measured lawn size",
// "Mowing difficulty", "debris haul-away"). For an HVAC or plumbing business that
// isn't a wrong word — it's a draft the owner cannot send, from a tool that clearly
// doesn't know what they do.
//
// The fix is NOT a trade setting. The context already carries the answer: real
// service_type values off the owner's own jobs and quotes, their own line items,
// their own notes. So the model is told to read the trade rather than be told it —
// which works for landscaping, HVAC, plumbing, electrical, cleaning, roofing, pest
// control, painting, junk removal and pool service without any of them being listed,
// and keeps working for whatever the next one is.
//
// The "say nothing" rule matters most on a brand-new customer with no history: with
// no services in context, a guess is what produces "your lawn" for an electrician.
const TRADE_UNKNOWN = `What this business actually does: read it from the context — the service names, job titles, quote line items and notes are their real work. Use their vocabulary for it. Never assume a trade, and never assume the work is lawn care, landscaping, or anything outdoors. If the context doesn't say what the work is, keep it general ("the visit", "the work", "the job") rather than guessing — guessing wrong reads as though we don't know them.`

// The owner's OWN service catalog beats inference. `service_templates` is the list
// they deliberately curated, and lib/marketing/businessContext already resolves it
// (templates decide WHAT is sold; job history only ranks it) — so this reads that
// seam rather than growing a second one. It matters because the alternative is
// inference over `jobs.service_type`, which is free text typed in the field and
// really does contain customer names ("Robert mowing") and non-services ("Call"):
// the exact reason businessContext exists. When the owner has no templates yet it
// returns null and we fall back to reading the trade from context, as before.
function tradeBlock(biz: BusinessContext): string {
  const line = contextLine(biz)
  return line
    ? `What this business actually does — this is their own service list, treat it as the authority: ${line} Use their vocabulary for it. If a detail of the work isn't in the context, keep it general ("the visit", "the work") rather than guessing.`
    : TRADE_UNKNOWN
}

const GUARDRAILS = `
Hard rules — these override everything else:
- Only state facts that appear in the context above. No invented prices, dates, times, names, services, or history. A missing detail is OMITTED, never guessed and never replaced with a placeholder.
- NEVER INVENT a placeholder for a detail you don't have: no [Name], [date], [your company], <insert …>, ____. If you don't have the detail, write around it. The tokens listed above are the only fill-in-the-blank markers that exist.
- PRESERVE VERBATIM, never delete or reword, the two markers the system replaces at send time: {{…}} tokens, and the exact literal text [Customer Portal Link] (this one is the customer's pay/portal link — it is NOT an invented placeholder, and dropping it sends a message with no link). This rule wins over the one above.
- Plain text only. No markdown syntax (no **, #, backticks, or bullet symbols other than "- " where the format explicitly asks for it) — the output is shown and sent as-is.
- Output ONLY the requested text. No preamble, no quotes around it, no explanation, no sign-off block unless the format asks for one.`

const trunc = (s: string | null | undefined, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const money = (n: number) => `$${Math.round(n * 100) / 100}`
const todayISO = () => new Date().toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86_400_000)

// Personalization tokens a DRAFT may carry. The send route runs every body
// (edited or not, single or bulk) through the same interpolation engine, so
// these resolve PER CUSTOMER at send time — which makes even a bulk draft
// personally addressed. Sourced from the same registry the template editor
// documents (lib/comms/templates), so the model and the owner see one list.
// Tokens that ALWAYS resolve: the send route derives them per recipient from the
// customer row and business settings, so they are safe on any draft, bulk included.
const ALWAYS_TOKENS = ['first_name', 'business_name', 'review_link', 'portal_link']

// Tokens that resolve ONLY from owner-supplied vars on this specific send. Offering
// one whose value is absent is how a draft acquires an unfillable hole: {{date}}
// with no dateLabel interpolates to the literal "soon" ("see you on soon"), and
// {{amount}} with no amount interpolates to nothing ("your balance is ."). The
// model can't know which vars this send carries — so only advertise the ones that
// will actually have a value.
const VAR_TOKENS: Array<{ key: string; has: (v: AssistPayload['vars']) => boolean }> = [
  { key: 'amount', has: v => !!trunc(v?.amount, 1) },
  { key: 'date', has: v => !!trunc(v?.dateLabel, 1) },
]

function tokenGuidance(vars: AssistPayload['vars']): string {
  const keys = [...ALWAYS_TOKENS, ...VAR_TOKENS.filter(t => t.has(vars)).map(t => t.key)]
  const rows = MSG_VARIABLES.filter(v => keys.includes(v.key)).map(v => `{{${v.key}}} = ${v.hint}`)
  // Name no token outside `rows` — an example mentioning one is the same as
  // offering it, which is the whole failure this gating exists to prevent.
  return `Personalization tokens you MAY use — they are replaced with each recipient's real values at send time, so they are the ONLY safe way to reference a detail you don't have: ${rows.join('; ')}. Each is replaced by a bare value and nothing else, so write any wording around it yourself — a token never supplies a preposition, a currency symbol or punctuation. Use one only where its value is clearly needed; never invent a token, and never use one that is not on this list.`
}

// What each template key actually means — the model gets an intent, not a slug.
const TEMPLATE_INTENT: Record<string, string> = {
  introduction: 'introduce the business to a new or prospective customer and open the door to booking',
  confirm: 'confirm an upcoming visit (date/time) and tell them what, if anything, they need to do',
  on_my_way: "tell the customer we're on our way now, with the ETA",
  running_late: 'apologize briefly for running behind and give the new ETA',
  rain_delay: 'let them know weather pushed their visit and what happens next',
  rescheduled: 'tell them their visit has been moved and confirm the new details',
  job_complete: 'tell them the work is done, and anything worth knowing about the visit',
  review_request: 'ask happy customers for a short review, with the review link',
  reminder: 'remind them about an upcoming visit or an amount due',
  thanks: 'thank them — for their business, a payment, or a referral',
  // The two money messages. Both are live entry points (the quote page and the
  // invoice page open the composer with these templates) and both used to fall
  // through to `custom` — "infer the intent from their draft and instruction" —
  // which on a fresh write has neither to infer from. No goal, no draft: the two
  // messages that decide whether we get paid were the two written blind.
  quote: 'send the customer their quote: tell them it is ready, point them to the link to review it, and make accepting it feel easy — never restate or estimate the price, the quote itself carries it',
  invoice: 'send the customer their invoice: tell them it is ready, point them to the link to view and pay it, and keep it matter-of-fact and easy to act on — never dun or pressure them',
  custom: 'whatever the owner needs — infer the intent from their draft and instruction',
}

// ── Customer context ──────────────────────────────────────────────────────────
// A compact, prompt-ready sketch of the relationship. Everything numeric is
// COMPUTED HERE and stated as a fact; the model never sums rows itself. All
// queries bounded and user-scoped.
async function customerContext(supabase: SupabaseClient, userId: string, customerId: string, opts?: { deep?: boolean }) {
  const today = todayISO()
  const [custRes, jobsRes, nextRes, quotesRes, invRes, msgRes, propRes, bizRes] = await Promise.all([
    supabase.from('customers').select('name, address, city, notes, tags, created_at, sms_opt_in, email_opt_in, last_contacted_at, review_rating, reviewed_at, review_source, review_requested_at, review_declined_at')
      .eq('user_id', userId).eq('id', customerId).maybeSingle(),
    supabase.from('jobs').select('title, service_type, scheduled_date, status, price, notes')
      .eq('user_id', userId).eq('customer_id', customerId).lte('scheduled_date', today)
      .order('scheduled_date', { ascending: false }).limit(opts?.deep ? 25 : 8),
    supabase.from('jobs').select('service_type, title, scheduled_date, start_time, status')
      .eq('user_id', userId).eq('customer_id', customerId).gt('scheduled_date', today)
      .in('status', ['scheduled', 'in_progress'])
      .order('scheduled_date', { ascending: true }).limit(2),
    supabase.from('quotes').select('quote_number, service_type, status, total, created_at')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(opts?.deep ? 10 : 4),
    supabase.from('invoices').select('invoice_number, status, amount, amount_paid, due_date, created_at')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(opts?.deep ? 20 : 8),
    supabase.from('messages').select('direction, channel, body, created_at')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(6),
    supabase.from('properties').select('address, neighborhood, lawn_sqft, notes')
      .eq('user_id', userId).eq('customer_id', customerId).limit(3),
    supabase.from('business_settings').select('company_name').eq('user_id', userId).maybeSingle(),
  ])
  const c = custRes.data as { name: string; address: string | null; city: string | null; notes: string | null; tags: string[] | null; created_at: string; sms_opt_in: boolean; email_opt_in: boolean; last_contacted_at?: string | null; review_rating?: number | null; reviewed_at?: string | null; review_source?: string | null; review_requested_at?: string | null; review_declined_at?: string | null } | null
  if (!c) return null
  const jobs = (jobsRes.data as Array<{ title: string; service_type: string | null; scheduled_date: string; status: string; price: number | null; notes: string | null }> | null) || []
  const upcoming = (nextRes.data as Array<{ service_type: string | null; title: string; scheduled_date: string; start_time: string | null; status: string }> | null) || []
  const quotes = (quotesRes.data as Array<{ quote_number: string; service_type: string; status: string; total: number; created_at: string }> | null) || []
  const invoices = (invRes.data as Array<{ invoice_number: string; status: string; amount: number; amount_paid: number | null; due_date: string | null; created_at: string }> | null) || []
  const msgs = (msgRes.data as Array<{ direction: string; channel: string; body: string | null; created_at: string }> | null) || []
  const props = (propRes.data as Array<{ address: string | null; neighborhood: string | null; lawn_sqft: number | null; notes: string | null }> | null) || []
  const company = (bizRes.data as { company_name: string | null } | null)?.company_name || 'the business'

  // Deterministic relationship math — stated to the model as ready-made facts.
  const done = jobs.filter(j => j.status === 'completed')
  const paidRevenue = invoices.reduce((s, i) => s + Number(i.amount_paid || 0), 0)
  const open = invoices.filter(i => i.status !== 'paid' && i.status !== 'cancelled' && Number(i.amount) > Number(i.amount_paid || 0))
  const openBalance = open.reduce((s, i) => s + (Number(i.amount) - Number(i.amount_paid || 0)), 0)
  const overdue = open.filter(i => i.due_date && i.due_date < today)

  // Visit cadence — median gap between completed visits (newest-first list).
  // With ≥3 completed visits this is a real rhythm; fewer is just noise.
  const gaps: number[] = []
  for (let i = 0; i + 1 < done.length; i++) {
    const g = daysBetween(done[i + 1].scheduled_date, done[i].scheduled_date)
    if (g > 0) gaps.push(g)
  }
  gaps.sort((a, b) => a - b)
  const medianGap = done.length >= 3 && gaps.length ? gaps[Math.floor(gaps.length / 2)] : null
  const daysSinceVisit = done.length ? daysBetween(done[0].scheduled_date, today) : null

  // ── Signals — the contractor's next-best-action, decided by CODE ────────────
  // Priority-ordered; the summary prompt is told to act on the FIRST one. Each
  // rule mirrors an existing app engine (dunning, follow-up radar, reactivation,
  // review lifecycle) so the AI recommends what the app already believes.
  const sentQuotes = quotes.filter(q => q.status === 'sent')
  const signals: string[] = []
  if (overdue.length) {
    const owed = overdue.reduce((s, i) => s + (Number(i.amount) - Number(i.amount_paid || 0)), 0)
    signals.push(`PAST-DUE MONEY: ${money(owed)} past due (${overdue.map(i => `#${i.invoice_number}`).join(', ')}) — collect before selling anything new.`)
  }
  for (const q of sentQuotes) {
    const age = daysBetween(q.created_at.slice(0, 10), today)
    signals.push(`OPEN QUOTE: #${q.quote_number} (${q.service_type}, $${q.total}) sent ${age} day${age !== 1 ? 's' : ''} ago, no decision — follow up.`)
  }
  if (medianGap != null && daysSinceVisit != null && !upcoming.length && daysSinceVisit > Math.round(medianGap * 1.5)) {
    signals.push(`OVERDUE FOR REBOOK: they typically book every ~${medianGap} days; it has been ${daysSinceVisit} days and nothing is scheduled.`)
  }
  if (!c.reviewed_at && !c.review_requested_at && !c.review_declined_at && done.length >= 2) {
    signals.push(`REVIEW NEVER ASKED: ${done.length} completed visits and we have never asked for a review.`)
  }
  if (!signals.length && c.last_contacted_at && daysBetween(String(c.last_contacted_at).slice(0, 10), today) > 45 && !upcoming.length) {
    signals.push(`GONE QUIET: no contact in ${daysBetween(String(c.last_contacted_at).slice(0, 10), today)} days and nothing scheduled — a light check-in keeps the relationship warm.`)
  }

  const lines: string[] = []
  lines.push(`Today's date: ${today}.`)
  lines.push(`Customer: ${c.name}${c.city ? ` (${c.city})` : ''} — customer since ${c.created_at.slice(0, 10)}.`)
  if (c.tags?.length) lines.push(`Tags: ${c.tags.slice(0, 6).join(', ')}.`)
  if (c.notes) lines.push(`Owner's private notes: ${trunc(c.notes, 300)}`)
  lines.push(`Relationship (computed): ${done.length} completed visit${done.length !== 1 ? 's' : ''}${done.length ? `, most recent ${done[0].scheduled_date}` : ''}${medianGap != null ? `, typically every ~${medianGap} days` : ''}${paidRevenue > 0 ? `; ${money(paidRevenue)} collected all-time` : ''}${openBalance > 0 ? `; ${money(openBalance)} currently unpaid${overdue.length ? ` of which ${money(overdue.reduce((s, i) => s + (Number(i.amount) - Number(i.amount_paid || 0)), 0))} is past due` : ''}` : '; nothing owing'}.`)
  if (upcoming.length) lines.push(`Next scheduled visit: ${upcoming[0].scheduled_date}${upcoming[0].start_time ? ` at ${upcoming[0].start_time}` : ''} — ${upcoming[0].service_type || upcoming[0].title}.`)
  else lines.push('No future visit is scheduled.')
  if (c.last_contacted_at) lines.push(`Last outbound contact: ${String(c.last_contacted_at).slice(0, 10)}.`)
  if (c.reviewed_at) lines.push(`Left a ${c.review_rating ?? '?'}-star review on ${c.review_source || 'Google'} (${String(c.reviewed_at).slice(0, 10)}).`)
  for (const p of props) {
    // `lawn_sqft` is the column's name, not a claim about what's there — it holds
    // whatever the measure tool measured. Stated neutrally so the model doesn't
    // infer a trade from our schema.
    lines.push(`Property: ${p.address || 'on file'}${p.neighborhood ? ` (${p.neighborhood})` : ''}${p.lawn_sqft ? `, measured area ≈${p.lawn_sqft} sqft` : ''}${p.notes ? ` — ${trunc(p.notes, 100)}` : ''}.`)
  }
  if (jobs.length) {
    lines.push('Recent visits (newest first):')
    for (const j of jobs) lines.push(`  - ${j.scheduled_date} · ${j.service_type || j.title} · ${j.status}${j.price != null ? ` · $${j.price}` : ''}${j.notes ? ` · ${trunc(j.notes, 80)}` : ''}`)
  }
  if (quotes.length) lines.push(`Quotes: ${quotes.map(q => `#${q.quote_number} ${q.service_type} ${q.status} $${q.total}`).join('; ')}.`)
  if (open.length) lines.push(`Open invoices: ${open.map(i => `#${i.invoice_number} ${i.status} ${money(Number(i.amount) - Number(i.amount_paid || 0))} outstanding${i.due_date ? `, due ${i.due_date}` : ''}`).join('; ')}.`)
  if (msgs.length) {
    lines.push('Conversation — the most recent messages, NEWEST FIRST (reply to the newest inbound one if it asks something):')
    for (const m of msgs) lines.push(`  - [${m.created_at.slice(0, 10)}] ${m.direction === 'inbound' ? 'CUSTOMER' : 'US'} (${m.channel}): ${trunc(m.body, 140)}`)
  }
  if (signals.length) {
    lines.push('Signals (computed by the app, highest priority first):')
    signals.slice(0, 4).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  } else {
    lines.push('Signals (computed by the app): none — nothing is owed, pending, or overdue.')
  }
  return {
    block: lines.join('\n'), company, name: c.name, firstName: c.name.split(' ')[0],
    hasThread: msgs.length > 0,
    services: [...new Set(done.map(j => j.service_type).filter(Boolean))].slice(0, 4) as string[],
    // Safe-to-surface relationship facts, for the tasks whose OUTPUT the customer
    // reads (a quote's scope notes print on the PDF). `block` must never go to
    // those: it carries the owner's private notes, lifetime revenue and invoice
    // numbers. These three carry the history without carrying the dossier.
    visitCount: done.length,
    lastVisit: done.length ? done[0].scheduled_date : null,
  }
}

async function businessName(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data } = await supabase.from('business_settings').select('company_name').eq('user_id', userId).maybeSingle()
  return (data as { company_name: string | null } | null)?.company_name || 'the business'
}

// The owner's own saved template wording (business_settings.message_templates)
// is the best sample of THEIR voice that exists — feed up to two overrides to
// the draft writer as style exemplars, preferring the one for the active
// template. Defaults aren't exemplars (they're ours, not the owner's).
async function ownerVoice(supabase: SupabaseClient, userId: string, activeTemplate?: string): Promise<{ company: string; exemplars: string[] }> {
  const { data } = await supabase.from('business_settings').select('company_name, message_templates').eq('user_id', userId).maybeSingle()
  const d = data as { company_name: string | null; message_templates: Record<string, string> | null } | null
  const overrides = d?.message_templates || {}
  const keys = Object.keys(overrides).filter(k => trunc(overrides[k], 10))
  keys.sort((a, b) => (a === activeTemplate ? -1 : 0) - (b === activeTemplate ? -1 : 0))
  return {
    company: d?.company_name || 'the business',
    exemplars: keys.slice(0, 2).map(k => trunc(overrides[k], 220)),
  }
}

// The property the owner already described, in their own words.
//
// getPropertyContext reads `property_intelligence` — AI Vision's cache — which only
// exists once Vision has actually analysed that property. In this database it holds
// zero rows against every property on file, so the Vision path resolves to '' every
// time and the scope writer has been working blind. The `properties` row the owner
// filled in themselves was there the whole time.
//
// Vision still wins when it exists (it sees things nobody typed); this is the floor
// beneath it, not a replacement. Resolved server-side from the customer when the
// caller didn't pass a property — the quote builder usually hasn't got one to pass.
async function propertySiteLine(
  supabase: SupabaseClient, userId: string, propertyId?: string, customerId?: string,
): Promise<string> {
  let q = supabase.from('properties').select('notes').eq('user_id', userId)
  if (propertyId) q = q.eq('id', propertyId)
  else if (customerId) q = q.eq('customer_id', customerId)
  else return ''
  const { data } = await q.limit(1)
  const notes = trunc((data as Array<{ notes: string | null }> | null)?.[0]?.notes, 300)
  if (!notes) return ''
  // These are the OWNER's private site notes, and this task's output prints on the
  // customer's quote. The notes field invites gate codes by design (the builder's
  // own placeholder asks for them), so the model is told what it may do with them.
  return `The owner's private site notes for this property — use them ONLY to judge which single expectation is worth setting, never copy them into the quote, and never repeat a gate code, lock combination, alarm code or key location into a document the customer will read: ${notes}`
}

// The linked visit, fetched server-side — real dates beat client-passed labels.
async function jobLine(supabase: SupabaseClient, userId: string, jobId: string | undefined): Promise<string> {
  if (!jobId) return ''
  const { data } = await supabase.from('jobs').select('service_type, title, scheduled_date, start_time, status')
    .eq('user_id', userId).eq('id', jobId).maybeSingle()
  const j = data as { service_type: string | null; title: string; scheduled_date: string; start_time: string | null; status: string } | null
  if (!j) return ''
  return `This message is about a specific visit: ${j.service_type || j.title} on ${j.scheduled_date}${j.start_time ? ` at ${j.start_time}` : ''} (status: ${j.status}).`
}

// ── Quote intelligence context ────────────────────────────────────────────────
// Everything the quote analyst may talk about, computed HERE from the owner's own
// book. The model explains these numbers; it never derives one, and it never gets
// to price anything — the persisted suggested_price/pricing_confidence columns are
// the pricing engine's opinion, carried through verbatim (the engine is the single
// source of truth for price; this task is read-only over it by design).
//
// Three decisions mirror owner rulings (2026-07-16, confirmed on this feature):
// • Won = positive learning, explicit decline = negative learning:
//   acceptance = accepted ÷ (accepted + declined). Nothing else has weight.
// • Ghost/unanswered quotes (still 'sent', no decision) are NEUTRAL and tracked
//   SEPARATELY — counted and shown, never folded into acceptance either way.
// • EXPIRED quotes follow the recorded Pricing V2 ruling verbatim — an expiry is
//   silence, not a "no" — and are NOT reinterpreted here.
// Plus: thin data is said out loud — every rate carries its sample size, and
// below 4 decided quotes the prompt orders the model to call the history thin.
async function quoteIntelContext(supabase: SupabaseClient, userId: string, quoteId: string) {
  const { data: qData } = await supabase.from('quotes')
    .select('id, quote_number, customer_id, property_id, service_type, status, total, suggested_price, pricing_confidence, created_at, sent_at, valid_until, notes')
    .eq('user_id', userId).eq('id', quoteId).maybeSingle()
  const q = qData as {
    id: string; quote_number: string | null; customer_id: string | null; property_id: string | null
    service_type: string | null; status: string; total: number | null
    suggested_price: number | null; pricing_confidence: string | null
    created_at: string; sent_at: string | null; valid_until: string | null; notes: string | null
  } | null
  if (!q) return null

  const [linesRes, ctx, biz, histRes, laborRes, propCtx] = await Promise.all([
    supabase.from('quote_services').select('service_type, quantity, unit, unit_price, est_minutes, discount_type, discount_value, notes')
      .eq('quote_id', quoteId).order('sort_order'),
    q.customer_id ? customerContext(supabase, userId, q.customer_id, { deep: true }) : Promise.resolve(null),
    loadBusinessContext(supabase, userId),
    // History for THIS service across the whole book — bounded, newest first.
    // 'sent' rides along so the neutral buckets can be COUNTED, never learned from.
    // There is NO 'expired' status in this schema — expiry is display-only,
    // derived from valid_until on a still-'sent' quote (lib/quoteStatus is THE rule).
    supabase.from('quotes').select('service_type, status, total, customer_id, created_at, valid_until')
      .eq('user_id', userId).neq('id', quoteId).in('status', ['accepted', 'scheduled', 'completed', 'paid', 'declined', 'sent'])
      .order('created_at', { ascending: false }).limit(400),
    supabase.from('labor_observations').select('service_type, estimated_minutes, actual_minutes')
      .eq('user_id', userId).order('service_date', { ascending: false }).limit(500),
    q.property_id ? getPropertyContext(supabase, q.property_id) : Promise.resolve(null),
  ])

  const lines = (linesRes.data as Array<{ service_type: string | null; quantity: number | null; unit: string | null; unit_price: number | null; est_minutes: number | null; discount_type: string | null; discount_value: number | null; notes: string | null }> | null) || []
  const primaryType = lines[0]?.service_type || q.service_type || ''
  const key = serviceKey(primaryType)
  const label = serviceLabel(key) || primaryType || 'this service'

  // ── Win/loss for this service (whole book) — code-computed facts ────────────
  // Won = the house WON set (accepted/scheduled/completed/paid — a quote that
  // progressed IS a win, same rule as lib/timeline). Lost = explicit decline.
  // Neutral, tracked separately per the owner's ruling: still-'sent' quotes,
  // split into expired (valid_until passed — silence, not a no) and awaiting.
  const WON_STATUSES = new Set(['accepted', 'scheduled', 'completed', 'paid'])
  const hist = ((histRes.data as Array<{ service_type: string | null; status: string; total: number | null; customer_id: string | null; created_at: string; valid_until: string | null }> | null) || [])
  const same = hist.filter(h => serviceKey(h.service_type || '') === key)
  const accepted = same.filter(h => WON_STATUSES.has(h.status))
  const declined = same.filter(h => h.status === 'declined')
  // Expiry via THE rule (lib/quoteStatus), never re-derived here.
  const expired = same.filter(h => isQuoteExpired({ status: h.status as never, valid_until: h.valid_until }, todayISO()))
  const ghosts = same.filter(h => h.status === 'sent' && !isQuoteExpired({ status: h.status as never, valid_until: h.valid_until }, todayISO()))
  const decided = accepted.length + declined.length
  const median = (arr: number[]) => { const s = arr.filter(n => n > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
  const medWon = median(accepted.map(h => Number(h.total) || 0))
  const medLost = median(declined.map(h => Number(h.total) || 0))
  // This customer's own record with us, service-agnostic.
  const custDecided = q.customer_id ? hist.filter(h => h.customer_id === q.customer_id) : []
  const custAccepted = custDecided.filter(h => WON_STATUSES.has(h.status)).length
  const custDeclined = custDecided.filter(h => h.status === 'declined').length

  // ── Time: the builder's own estimate + how estimates have actually landed ───
  const estMinutes = lines.reduce((s, l) => s + (Number(l.est_minutes) || 0), 0)
  const obs = ((laborRes.data as Array<{ service_type: string | null; estimated_minutes: number | null; actual_minutes: number | null }> | null) || [])
    .filter(o => serviceKey(o.service_type || '') === key && Number(o.actual_minutes) > 0)
  const obsWithEst = obs.filter(o => Number(o.estimated_minutes) > 0)
  const medActual = median(obs.map(o => Number(o.actual_minutes) || 0))
  const avgErrPct = obsWithEst.length
    ? Math.round(obsWithEst.reduce((s, o) => s + ((Number(o.actual_minutes) - Number(o.estimated_minutes)) / Number(o.estimated_minutes)), 0) / obsWithEst.length * 100)
    : null

  const today = todayISO()
  const facts: string[] = []
  facts.push(`Today's date: ${today}.`)
  facts.push(`THE QUOTE — #${q.quote_number || q.id.slice(0, 6)}: status ${q.status}, total ${q.total != null ? money(Number(q.total)) : 'not set'}, primary service "${label}".`)
  if (lines.length) {
    facts.push('Line items, in order:')
    for (const l of lines) facts.push(`  - ${trunc(l.service_type, 60) || '(unnamed)'}${l.quantity && l.quantity !== 1 ? ` × ${l.quantity}${l.unit ? ` ${l.unit}` : ''}` : ''}${l.unit_price != null ? ` @ ${money(Number(l.unit_price))}` : ''}${l.discount_value ? ` (discount: ${l.discount_type === 'percent' ? `${l.discount_value}%` : money(Number(l.discount_value))})` : ''}${l.est_minutes ? ` · est ${l.est_minutes} min` : ''}${l.notes ? ` · ${trunc(l.notes, 80)}` : ''}`)
  }
  if (q.suggested_price != null) {
    facts.push(`THE PRICING ENGINE'S OPINION (persisted with this quote — the single source of truth on price): suggested ${money(Number(q.suggested_price))}${q.pricing_confidence ? `, stated confidence "${q.pricing_confidence}"` : ''}. The quoted total is ${q.total != null && Number(q.suggested_price) > 0 ? `${Math.round((Number(q.total) / Number(q.suggested_price)) * 100)}% of the suggestion` : 'not comparable'}.`)
  } else {
    facts.push('The pricing engine recorded no suggested price for this quote (no basis at the time).')
  }
  if (q.sent_at) facts.push(`Sent ${String(q.sent_at).slice(0, 10)} (${daysBetween(String(q.sent_at).slice(0, 10), today)} days ago).${q.valid_until ? ` Valid until ${String(q.valid_until).slice(0, 10)}.` : ''}`)
  facts.push(`WIN/LOSS HISTORY for "${label}" across the whole book (computed — only won and explicitly declined quotes carry learning weight; won = accepted, scheduled, completed or paid): ${accepted.length} won, ${declined.length} declined${decided ? `; acceptance ${Math.round((accepted.length / decided) * 100)}% of ${decided} decided` : ''}${medWon != null ? `; median won total ${money(medWon)}` : ''}${medLost != null ? `; median declined total ${money(medLost)}` : ''}. Tracked separately, NEUTRAL, no learning weight either way: ${ghosts.length} still awaiting an answer${expired.length ? `, ${expired.length} expired (expiry is silence, not a no)` : ''}.`)
  if (decided < 4) facts.push(`SAMPLE WARNING: only ${decided} decided quote${decided !== 1 ? 's' : ''} for this service — history is too thin to lean on; say so plainly wherever it matters.`)
  if (q.customer_id) facts.push(`THIS CUSTOMER'S quote record with us (all services): ${custAccepted} won, ${custDeclined} declined.`)
  if (estMinutes > 0) facts.push(`TIME: the builder estimated ${estMinutes} minutes across the line items.`)
  if (obs.length) facts.push(`TIME HISTORY for "${label}": ${obs.length} completed observation${obs.length !== 1 ? 's' : ''}${medActual != null ? `, median actual ${medActual} min` : ''}${avgErrPct != null ? `; past estimates ran on average ${Math.abs(avgErrPct)}% ${avgErrPct >= 0 ? 'UNDER actual (jobs take longer than estimated)' : 'OVER actual (jobs finish faster than estimated)'} across ${obsWithEst.length} estimated jobs` : ''}.`)
  else facts.push(`TIME HISTORY: no completed time observations for "${label}" yet.`)
  const catalog = (biz.services || []).map(s => trunc(s, 50)).filter(Boolean)
  if (catalog.length) facts.push(`THE OWNER'S SERVICE CATALOG (the ONLY universe for upsell or missing-service suggestions): ${catalog.join('; ')}.`)
  else facts.push('The owner has no service catalog on file — DO NOT suggest any upsell or missing service.')
  const visionLine = propertyContextBlock(propCtx)
  if (visionLine) facts.push(visionLine)
  if (ctx) {
    facts.push('THE CUSTOMER (full relationship dossier, owner-private):')
    facts.push(ctx.block)
  } else {
    facts.push('No customer is attached to this quote yet.')
  }
  return { q, facts: facts.join('\n'), label, thin: decided < 4, company: ctx?.company, biz }
}

const tiered = (tier: AiTier) => modelForTier(tier)

// Build the full generation input for a task. Throws Error(message) on bad
// requests — the route converts that to a 400.
export async function buildAssistInput(
  supabase: SupabaseClient,
  userId: string,
  p: AssistPayload,
): Promise<AssistInput> {
  switch (p.task) {
    case 'draft_message': {
      const channels = (p.channels || []).filter(c => c === 'sms' || c === 'email')
      // Three shapes, not two. There was an SMS branch and an everything-else branch,
      // so an EMAIL-only send was written to the "text and/or email" rules: squeezed
      // under 500 characters, greeting optional, no room to say anything properly.
      // An email and a text are not the same message and never were.
      const smsOnly = channels.length === 1 && channels[0] === 'sms'
      const emailOnly = channels.length === 1 && channels[0] === 'email'
      const intent = TEMPLATE_INTENT[trunc(p.template, 40)] || TEMPLATE_INTENT.custom
      const [voice, biz] = await Promise.all([
        ownerVoice(supabase, userId, trunc(p.template, 40)),
        loadBusinessContext(supabase, userId),
      ])
      const company = voice.company
      let context = ''
      let hasThread = false
      if (p.customerId && !p.bulk) {
        const ctx = await customerContext(supabase, userId, p.customerId)
        if (!ctx) throw new Error('customer not found')
        context = ctx.block
        hasThread = ctx.hasThread
      }
      const job = await jobLine(supabase, userId, p.jobId)
      const varBits = [
        p.vars?.dateLabel ? `date: ${trunc(p.vars.dateLabel, 40)}` : '',
        p.vars?.timeWindow ? `time window: ${trunc(p.vars.timeWindow, 40)}` : '',
        p.vars?.address ? `address: ${trunc(p.vars.address, 80)}` : '',
        p.vars?.amount ? `amount: ${trunc(p.vars.amount, 20)}` : '',
      ].filter(Boolean).join('; ')
      const rewrite = !!trunc(p.currentText, 10)
      const system = `You write customer messages for ${company}, a small local services business.
${tradeBlock(biz)}
${STYLE}
${smsOnly
  ? 'Format: a TEXT MESSAGE. 1–3 short sentences, under 300 characters (one SMS segment of 160 is even better). No greeting line, no sign-off block — at most the business name worked in once, naturally.'
  : emailOnly
    ? 'Format: an EMAIL body. Two or three short paragraphs, up to about 120 words — an email has room, so use it to be clear rather than terse, but never pad. Open by greeting the customer by first name on its own line. Do NOT write a subject line and do NOT write a signature block; the system adds both.'
    : 'Format: ONE text that goes out as both a text message and an email body, so it has to work as a text: under 500 characters, a few short sentences. Start with the customer\'s first name only if the context gives it. No subject line, no signature block; the business name at most once.'}
${p.bulk ? 'This text goes to MANY customers at once: never type a literal name or any per-customer detail — but you SHOULD greet with the {{first_name}} token, which resolves to each recipient\'s own name at send time. Everything else must read correct for every recipient (seasonal/general phrasing).' : ''}
${tokenGuidance(p.vars)}
${voice.exemplars.length ? `How this business actually writes — match this voice over the generic default (copy the tone, not the content; ignore any **bold** marks, they are template styling):\n${voice.exemplars.map(e => `EXAMPLE: "${e}"`).join('\n')}` : ''}
The message must be complete and sendable as-is — if it makes an offer or asks something, make the next step obvious (reply, link, or call).
${GUARDRAILS}`
      const prompt = [
        context ? `Context about the recipient:\n${context}\n` : `Today's date: ${todayISO()}.`,
        job,
        varBits ? `Details supplied by the owner for this message — treat as correct: ${varBits}.` : '',
        `Goal of this message: ${intent}.`,
        hasThread && !rewrite ? 'If the newest CUSTOMER message in the conversation asks a question, answer it directly in this message.' : '',
        p.instruction ? `The owner's instruction (follow it): ${trunc(p.instruction, 400)}` : '',
        rewrite
          ? `Rewrite the following draft. Keep its meaning and EVERY factual detail (numbers, dates, tokens); fix wording, warmth and flow; cut filler:\n---\n${trunc(p.currentText, 1500)}\n---`
          : 'Write the message.',
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 400, model: tiered('balanced') }
    }

    case 'customer_summary': {
      if (!p.customerId) throw new Error('customerId required')
      const [ctx, biz] = await Promise.all([
        customerContext(supabase, userId, p.customerId, { deep: true }),
        loadBusinessContext(supabase, userId),
      ])
      if (!ctx) throw new Error('customer not found')
      const system = `You brief the owner of ${ctx.company}, a small local services business, on one customer in the 30 seconds before a call or visit.
Format — exactly these five lines, in this order, each one sentence (max ~20 words), plain text:
- Who: name, where, how long they've been a customer, what they buy.
- Money: lifetime collected, anything unpaid or past due (exact figures are in the context — use them verbatim).
- Lately: the most recent visit/conversation activity, and the next scheduled visit or "nothing booked".
- Watch: the one thing that could lose this customer or is waiting on the owner ("nothing" if genuinely nothing). If the context lists Signals, this is usually signal #2.
- Next: ONE concrete action. The context ends with app-computed Signals in priority order — act on signal #1 and restate its reason with its exact numbers (e.g. "chase invoice #1042 — $180 past due"). If Signals says "none", say so and name the healthiest habit to keep (e.g. "nothing needed — next visit is booked").
Never invent a recommendation the Signals and data don't support.
${tradeBlock(biz)}
${STYLE}
${GUARDRAILS}`
      const prompt = `Here is everything on file:\n${ctx.block}\n\nWrite the five-line brief.`
      return { system, prompt, maxTokens: 500, model: tiered('smart') }
    }

    case 'review_response': {
      if (!p.customerId) throw new Error('customerId required')
      const [ctx, biz] = await Promise.all([
        customerContext(supabase, userId, p.customerId),
        loadBusinessContext(supabase, userId),
      ])
      if (!ctx) throw new Error('customer not found')
      // The star rating decides whether this reply thanks or apologizes — getting it
      // wrong is worse than saying less. It is NOT defaulted: an unrecorded rating
      // (the customers row allows null) must never be read as 5 stars.
      const rawRating = Number(p.rating)
      const rating = Number.isFinite(rawRating) && rawRating >= 1
        ? Math.min(5, Math.max(1, Math.round(rawRating)))
        : null
      const shape = rating === null
        ? 'The star rating was never recorded, so their sentiment is UNKNOWN — this reply must read correctly whether they praised us or complained. Thank them once for taking the time to leave feedback, plainly and without effusive praise, and invite them to reach out directly if there is anything they want handled. Do NOT gush, do NOT apologize for a problem you cannot see, and do NOT characterize the review.'
        : rating >= 4
          ? 'A positive review: thank them genuinely and SPECIFICALLY — reference the kind of work we actually did for them (from the context) rather than generic praise — and welcome them back. No discounts or incentives, no begging for referrals.'
          : rating === 3
            ? 'A mixed review: thank them for the honest feedback, acknowledge there was room to be better, and say you\'d value hearing more directly so the next visit is right.'
            : 'A critical review: thank them for the feedback, apologize once without excuses and without arguing any detail, and invite them to continue directly (phone or email) so you can make it right. Never dispute their account publicly, never mention compensation.'
      const system = `You write the business owner's PUBLIC reply to a customer review of ${ctx.company} (posted on ${trunc(p.source, 30) || 'Google'}). 2–4 sentences, under 60 words.
${shape}
This reply is public: use the reviewer's FIRST NAME only, and never reveal their address, prices paid, invoice details, or visit dates. Naming the KIND of work is as specific as it gets, and only using the words the context uses for it — if the context doesn't name it, say "the work" or "the visit".
Don't open with "Thank you so much" — vary the opener. Use the business name at most once.
${tradeBlock(biz)}
${STYLE}
${GUARDRAILS}`
      const prompt = `Reviewer: ${ctx.firstName}. Rating: ${rating === null ? 'not recorded — sentiment unknown' : `${rating}/5`}.${ctx.services.length ? ` Services we've actually done for them: ${ctx.services.join(', ')}.` : ''}\nBackground (PRIVATE — for your understanding only, not for quoting publicly):\n${ctx.block}\n\nWrite the public reply.`
      return { system, prompt, maxTokens: 300, model: tiered('balanced') }
    }

    case 'quote_scope': {
      const [company, biz, propCtx, ctx] = await Promise.all([
        businessName(supabase, userId),
        loadBusinessContext(supabase, userId),
        p.propertyId ? getPropertyContext(supabase, p.propertyId) : Promise.resolve(null),
        // The customer id was already in scope at the call site and simply unused, so
        // the scope writer couldn't say the line that wins a repeat quote: "the same
        // work we did in April". Only the safe facts are used below — never ctx.block,
        // which carries private notes and money into a customer-facing document.
        p.customerId ? customerContext(supabase, userId, p.customerId) : Promise.resolve(null),
      ])
      const propLine = propertyContextBlock(propCtx) || await propertySiteLine(supabase, userId, p.propertyId, p.customerId)
      // The owner's per-item notes were collected by the builder, sent over the wire,
      // and then dropped here (only `s.name` was read) — the richest description of
      // the work that exists, thrown away one line before the prompt.
      const services = (p.services || [])
        .map(s => ({ name: trunc(s.name, 60), notes: trunc(s.notes, 200) }))
        .filter(s => s.name || s.notes)
      const historyLine = ctx && ctx.visitCount > 0
        ? `This is an existing customer: ${ctx.visitCount} completed visit${ctx.visitCount !== 1 ? 's' : ''}${ctx.lastVisit ? `, most recently on ${ctx.lastVisit}` : ''}${ctx.services.length ? ` (${ctx.services.join(', ')})` : ''}. Reference that history where it genuinely helps ("the same work we did in April") — never mention what they paid.`
        : ''
      const system = `You write the scope-of-work notes that appear on a quote from ${company}, a small local services company. The reader is the customer deciding whether to accept.
Write 2–5 short sentences, addressed to the customer ("we'll…", "your…"): exactly WHAT will be done (walk the line items in order), and one expectation worth setting — but ONLY one the context actually supports, and only the kind that fits this trade (for example access or parking, something they need to move or switch off, or clean-up and disposal). Never invent an expectation to fill the slot, and never assume the work depends on weather.
NEVER state or estimate any price, total, rate, or discount — pricing lives elsewhere on the quote. NEVER promise outcomes, timelines, or guarantees that aren't in the context. No bullet points unless the owner's rough notes already use them.
${tradeBlock(biz)}
${STYLE}
${GUARDRAILS}`
      const prompt = [
        `Today's date: ${todayISO()}.`,
        p.serviceType ? `Primary service: ${trunc(p.serviceType, 60)}.` : '',
        services.length
          ? `Line items on the quote, in order:\n${services.map(s => `  - ${s.name || '(unnamed item)'}${s.notes ? `\n    What the owner wrote about this item — their own words for what it involves, and the best description of this work that exists; build the sentence for this item on it: ${s.notes}` : ''}`).join('\n')}`
          : '',
        historyLine,
        p.address ? `Property address: ${trunc(p.address, 80)}.` : '',
        // The column behind this is lawn_sqft (the measure tool's origin), but it is
        // just a measured area on a property. Calling it a lawn to the model is how a
        // roofer's quote ends up talking about grass.
        p.measuredSqft && p.measuredSqft > 0 ? `Measured area at this property: ${Math.round(p.measuredSqft)} sqft (measured on the map, not estimated — you may reference it if it's relevant to this trade).` : '',
        propLine,
        trunc(p.draft, 10) ? `The owner's rough notes to build from (keep every fact in them):\n---\n${trunc(p.draft, 1200)}\n---` : 'Write the scope notes from the line items above.',
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 350, model: tiered('smart') }
    }

    case 'job_notes': {
      if (!trunc(p.draft, 3)) throw new Error('nothing to clean up')
      const [company, biz] = await Promise.all([
        businessName(supabase, userId),
        loadBusinessContext(supabase, userId),
      ])
      const system = `You clean up rough job notes for ${company}, a small local services business. The reader is whoever does the work (possibly the owner themselves) opening this job months from now.
Keep EVERY fact exactly as given — gate codes, door numbers, phone digits, measurements, part numbers, names, prices stay VERBATIM, never rounded or reworded. Fix grammar and shorthand, group related points, drop only pure filler. Same length or shorter.
If the notes cover distinct topics, prefix them inline with short plain-text labels like "Access:", "Requests:", "Site:" — one line each, no markdown.
${tradeBlock(biz)}
${GUARDRAILS}`
      const prompt = [
        p.serviceType ? `Job type: ${trunc(p.serviceType, 60)}.` : '',
        `Rough notes:\n---\n${trunc(p.draft, 2000)}\n---\nRewrite them.`,
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 400, model: tiered('fast') }
    }

    case 'quote_intelligence': {
      if (!p.quoteId) throw new Error('quoteId required')
      const intel = await quoteIntelContext(supabase, userId, p.quoteId)
      if (!intel) throw new Error('quote not found')
      const focus = p.focus && ['pricing', 'upsells', 'gaps', 'time', 'risk'].includes(p.focus) ? p.focus : 'full'
      // Owner-facing sections. Each instruction says what the section may draw on,
      // so a lens never wanders into another lens's facts.
      const SECTIONS: Record<string, string> = {
        pricing: `Price: how this quote's total sits against the pricing engine's suggestion and the accepted/declined medians for this service — and what the engine's stated confidence means given the sample sizes in the context. Explain; NEVER propose a different number. If the engine gave no suggestion, say what that means (no basis yet) rather than filling the gap.`,
        upsells: `Upsells: at most TWO services from THE OWNER'S SERVICE CATALOG (nowhere else) that genuinely fit this job, this property, and this customer's history — with the one-line reason each. "Nothing worth adding" is a good answer and better than a stretch.`,
        gaps: `Missing services: anything this customer buys regularly (their visit history) that is NOT on this quote — name it and the last time they had it. If nothing is missing, say the quote covers their usual work.`,
        time: `Time: what the line-item estimate is, and how estimates for this service have actually landed (the TIME HISTORY line — median actual, average error, sample size). If there is no history, say the estimate is unproven rather than judging it.`,
        risk: `Risk: what could stall this — drawn ONLY from the context (past-due balances, this customer's declines, quote age/expiry, no way to reach them, thin history). One line per real risk, most serious first; "low risk" is a legitimate answer.`,
      }
      const ask = focus === 'full'
        ? `Write the brief as exactly five short sections, in this order, each 1–3 plain sentences prefixed with its label on its own line:\n${['pricing', 'upsells', 'gaps', 'time', 'risk'].map(k => `${SECTIONS[k]}`).join('\n')}`
        : `Write ONLY this one section, 2–5 plain sentences, no label needed:\n${SECTIONS[focus]}`
      const system = `You are the estimator's second opinion at ${intel.company || 'a small local services business'}, briefing the owner on ONE quote before they send or chase it. You explain what their own numbers say; you never replace them.
Hard boundaries for this task:
- The pricing engine's suggested price and confidence are the authority on price. You may explain them and compare the quoted total to history, but NEVER recommend a different price, a discount, or a rounding.
- Every number you state must appear in the context verbatim — sample sizes included. Where the context flags thin history, lead with that caveat in the affected section.
- Upsell/missing-service suggestions may come ONLY from the owner's service catalog and the customer's own history.
- This brief is PRIVATE to the owner — relationship and money facts may be used freely, but write nothing here that you'd need to warn them not to paste to a customer: no snark about the customer, plain professional judgement.
${tradeBlock(intel.biz)}
${STYLE}
${GUARDRAILS}`
      const prompt = `Everything on file for this quote:\n${intel.facts}\n\n${ask}`
      return { system, prompt, maxTokens: focus === 'full' ? 700 : 400, model: tiered('smart') }
    }
  }
}
