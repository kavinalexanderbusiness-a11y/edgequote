import type { SupabaseClient } from '@supabase/supabase-js'
import { modelForTier, type AiTier } from '@/lib/ai/anthropic'
import { getPropertyContext, propertyContextBlock } from '@/lib/ai/propertyContext'

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

const GUARDRAILS = `
Hard rules — these override everything else:
- Only state facts that appear in the context above. No invented prices, dates, times, names, services, or history. A missing detail is OMITTED, never guessed and never replaced with a placeholder.
- NEVER output bracketed placeholders of any kind: no [Name], [date], [your company], <insert …>, ____. If you don't have the detail, write around it.
- Keep template tokens exactly as written when they appear in the draft (e.g. {{portal_link}}, [Customer Portal Link]) — the system replaces them at send time.
- Plain text only. No markdown syntax (no **, #, backticks, or bullet symbols other than "- " where the format explicitly asks for it) — the output is shown and sent as-is.
- Output ONLY the requested text. No preamble, no quotes around it, no explanation, no sign-off block unless the format asks for one.`

const trunc = (s: string | null | undefined, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const money = (n: number) => `$${Math.round(n * 100) / 100}`
const todayISO = () => new Date().toISOString().slice(0, 10)

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
  custom: 'whatever the owner needs — infer the intent from their draft and instruction',
}

// ── Customer context ──────────────────────────────────────────────────────────
// A compact, prompt-ready sketch of the relationship. Everything numeric is
// COMPUTED HERE and stated as a fact; the model never sums rows itself. All
// queries bounded and user-scoped.
async function customerContext(supabase: SupabaseClient, userId: string, customerId: string, opts?: { deep?: boolean }) {
  const today = todayISO()
  const [custRes, jobsRes, nextRes, quotesRes, invRes, msgRes, propRes, bizRes] = await Promise.all([
    supabase.from('customers').select('name, address, city, notes, tags, created_at, sms_opt_in, email_opt_in, last_contacted_at, review_rating, reviewed_at, review_source')
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
  const c = custRes.data as { name: string; address: string | null; city: string | null; notes: string | null; tags: string[] | null; created_at: string; sms_opt_in: boolean; email_opt_in: boolean; last_contacted_at?: string | null; review_rating?: number | null; reviewed_at?: string | null; review_source?: string | null } | null
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

  const lines: string[] = []
  lines.push(`Today's date: ${today}.`)
  lines.push(`Customer: ${c.name}${c.city ? ` (${c.city})` : ''} — customer since ${c.created_at.slice(0, 10)}.`)
  if (c.tags?.length) lines.push(`Tags: ${c.tags.slice(0, 6).join(', ')}.`)
  if (c.notes) lines.push(`Owner's private notes: ${trunc(c.notes, 300)}`)
  lines.push(`Relationship (computed): ${done.length} completed visit${done.length !== 1 ? 's' : ''}${done.length ? `, most recent ${done[0].scheduled_date}` : ''}${paidRevenue > 0 ? `; ${money(paidRevenue)} collected all-time` : ''}${openBalance > 0 ? `; ${money(openBalance)} currently unpaid${overdue.length ? ` of which ${money(overdue.reduce((s, i) => s + (Number(i.amount) - Number(i.amount_paid || 0)), 0))} is past due` : ''}` : '; nothing owing'}.`)
  if (upcoming.length) lines.push(`Next scheduled visit: ${upcoming[0].scheduled_date}${upcoming[0].start_time ? ` at ${upcoming[0].start_time}` : ''} — ${upcoming[0].service_type || upcoming[0].title}.`)
  else lines.push('No future visit is scheduled.')
  if (c.last_contacted_at) lines.push(`Last outbound contact: ${String(c.last_contacted_at).slice(0, 10)}.`)
  if (c.reviewed_at) lines.push(`Left a ${c.review_rating ?? '?'}-star review on ${c.review_source || 'Google'} (${String(c.reviewed_at).slice(0, 10)}).`)
  for (const p of props) {
    lines.push(`Property: ${p.address || 'on file'}${p.neighborhood ? ` (${p.neighborhood})` : ''}${p.lawn_sqft ? `, lawn ≈${p.lawn_sqft} sqft` : ''}${p.notes ? ` — ${trunc(p.notes, 100)}` : ''}.`)
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
  return {
    block: lines.join('\n'), company, name: c.name, firstName: c.name.split(' ')[0],
    hasThread: msgs.length > 0,
    services: [...new Set(done.map(j => j.service_type).filter(Boolean))].slice(0, 4) as string[],
  }
}

async function businessName(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data } = await supabase.from('business_settings').select('company_name').eq('user_id', userId).maybeSingle()
  return (data as { company_name: string | null } | null)?.company_name || 'the business'
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
      const smsOnly = channels.length === 1 && channels[0] === 'sms'
      const intent = TEMPLATE_INTENT[trunc(p.template, 40)] || TEMPLATE_INTENT.custom
      let context = ''
      let company = ''
      let hasThread = false
      if (p.customerId && !p.bulk) {
        const ctx = await customerContext(supabase, userId, p.customerId)
        if (!ctx) throw new Error('customer not found')
        context = ctx.block
        company = ctx.company
        hasThread = ctx.hasThread
      } else {
        company = await businessName(supabase, userId)
      }
      const job = await jobLine(supabase, userId, p.jobId)
      const varBits = [
        p.vars?.dateLabel ? `date: ${trunc(p.vars.dateLabel, 40)}` : '',
        p.vars?.timeWindow ? `time window: ${trunc(p.vars.timeWindow, 40)}` : '',
        p.vars?.address ? `address: ${trunc(p.vars.address, 80)}` : '',
        p.vars?.amount ? `amount: ${trunc(p.vars.amount, 20)}` : '',
      ].filter(Boolean).join('; ')
      const rewrite = !!trunc(p.currentText, 10)
      const system = `You write customer messages for ${company}, a small local property-services company.
${STYLE}
${smsOnly
  ? 'Format: a TEXT MESSAGE. 1–3 short sentences, under 300 characters (one SMS segment of 160 is even better). No greeting line, no sign-off block — at most the business name worked in once, naturally.'
  : 'Format: goes out as a text and/or an email body. Under 500 characters, a few short sentences. Start with the customer\'s first name only if the context gives it. No subject line, no signature block; the business name at most once.'}
${p.bulk ? 'This EXACT text goes to MANY customers at once: no names, no per-customer details, nothing that could be wrong for any one of them. Seasonal/general phrasing only.' : ''}
The message must be complete and sendable as-is — if it makes an offer or asks something, make the next step obvious (reply, link, or call).
${GUARDRAILS}`
      const prompt = [
        context ? `Context about the recipient:\n${context}\n` : '',
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
      const ctx = await customerContext(supabase, userId, p.customerId, { deep: true })
      if (!ctx) throw new Error('customer not found')
      const system = `You brief the owner of ${ctx.company}, a small property-services company, on one customer in the 30 seconds before a call or visit.
Format — exactly these five lines, in this order, each one sentence (max ~20 words), plain text:
- Who: name, where, how long they've been a customer, what they buy.
- Money: lifetime collected, anything unpaid or past due (exact figures are in the context — use them verbatim).
- Lately: the most recent visit/conversation activity, and the next scheduled visit or "nothing booked".
- Watch: the one thing that could lose this customer or is waiting on the owner ("nothing" if genuinely nothing).
- Next: ONE concrete action with a reason, grounded in the data (e.g. rebook — recurring history but nothing scheduled; chase invoice #X — past due).
${STYLE}
${GUARDRAILS}`
      const prompt = `Here is everything on file:\n${ctx.block}\n\nWrite the five-line brief.`
      return { system, prompt, maxTokens: 500, model: tiered('smart') }
    }

    case 'review_response': {
      if (!p.customerId) throw new Error('customerId required')
      const ctx = await customerContext(supabase, userId, p.customerId)
      if (!ctx) throw new Error('customer not found')
      const rating = Math.min(5, Math.max(1, Math.round(p.rating || 5)))
      const shape = rating >= 4
        ? 'A positive review: thank them genuinely and SPECIFICALLY — reference the kind of work we actually did for them (from the context) rather than generic praise — and welcome them back. No discounts or incentives, no begging for referrals.'
        : rating === 3
          ? 'A mixed review: thank them for the honest feedback, acknowledge there was room to be better, and say you\'d value hearing more directly so the next visit is right.'
          : 'A critical review: thank them for the feedback, apologize once without excuses and without arguing any detail, and invite them to continue directly (phone or email) so you can make it right. Never dispute their account publicly, never mention compensation.'
      const system = `You write the business owner's PUBLIC reply to a customer review of ${ctx.company} (posted on ${trunc(p.source, 30) || 'Google'}). 2–4 sentences, under 60 words.
${shape}
This reply is public: use the reviewer's FIRST NAME only, and never reveal their address, prices paid, invoice details, or visit dates — the kind of service ("your lawn", "the spring cleanup") is as specific as it gets.
Don't open with "Thank you so much" — vary the opener. Use the business name at most once.
${STYLE}
${GUARDRAILS}`
      const prompt = `Reviewer: ${ctx.firstName}. Rating: ${rating}/5.${ctx.services.length ? ` Services we've actually done for them: ${ctx.services.join(', ')}.` : ''}\nBackground (PRIVATE — for your understanding only, not for quoting publicly):\n${ctx.block}\n\nWrite the public reply.`
      return { system, prompt, maxTokens: 300, model: tiered('balanced') }
    }

    case 'quote_scope': {
      const company = await businessName(supabase, userId)
      const propCtx = p.propertyId ? await getPropertyContext(supabase, p.propertyId) : null
      const propLine = propertyContextBlock(propCtx)
      const services = (p.services || []).map(s => trunc(s.name, 60)).filter(Boolean)
      const system = `You write the scope-of-work notes that appear on a quote from ${company}, a small property-services company. The reader is the homeowner deciding whether to accept.
Write 2–5 short sentences, addressed to the customer ("we'll…", "your…"): exactly WHAT will be done (walk the line items in order), and one expectation worth setting (access needed, weather dependency, debris haul-away — only if the context supports it).
NEVER state or estimate any price, total, rate, or discount — pricing lives elsewhere on the quote. NEVER promise outcomes, timelines, or guarantees that aren't in the context. No bullet points unless the owner's rough notes already use them.
${STYLE}
${GUARDRAILS}`
      const prompt = [
        `Today's date: ${todayISO()}.`,
        p.serviceType ? `Primary service: ${trunc(p.serviceType, 60)}.` : '',
        services.length ? `Line items on the quote, in order: ${services.join('; ')}.` : '',
        p.address ? `Property address: ${trunc(p.address, 80)}.` : '',
        p.measuredSqft && p.measuredSqft > 0 ? `Measured lawn size: ${Math.round(p.measuredSqft)} sqft (measured, not estimated — you may reference it).` : '',
        propLine,
        trunc(p.draft, 10) ? `The owner's rough notes to build from (keep every fact in them):\n---\n${trunc(p.draft, 1200)}\n---` : 'Write the scope notes from the line items above.',
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 350, model: tiered('smart') }
    }

    case 'job_notes': {
      if (!trunc(p.draft, 3)) throw new Error('nothing to clean up')
      const company = await businessName(supabase, userId)
      const system = `You clean up rough job notes for ${company}, a small property-services company. The reader is the crew (possibly the owner themselves) opening this job months from now.
Keep EVERY fact exactly as given — gate codes, door numbers, phone digits, measurements, names, prices stay VERBATIM, never rounded or reworded. Fix grammar and shorthand, group related points, drop only pure filler. Same length or shorter.
If the notes cover distinct topics, prefix them inline with short plain-text labels like "Access:", "Requests:", "Site:" — one line each, no markdown.
${GUARDRAILS}`
      const prompt = [
        p.serviceType ? `Job type: ${trunc(p.serviceType, 60)}.` : '',
        `Rough notes:\n---\n${trunc(p.draft, 2000)}\n---\nRewrite them.`,
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 400, model: tiered('fast') }
    }
  }
}
