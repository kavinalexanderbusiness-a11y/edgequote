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
  // review_response
  rating?: number
  source?: string
  // quote_scope
  propertyId?: string
  serviceType?: string
  services?: Array<{ name?: string; notes?: string }>  // labels only, no prices
  // job_notes / quote_scope free text
  draft?: string
}

export interface AssistInput {
  system: string
  prompt: string
  maxTokens: number
  model: string
}

// Shared guardrails appended to every system prompt.
const GUARDRAILS = `
Rules that always apply:
- Never invent facts: no prices, dates, times, names, or history beyond what is given above. If a detail is missing, leave it out or use a neutral phrase — never guess.
- Keep any template tokens exactly as written (e.g. {{portal_link}}, [Customer Portal Link]) — they are replaced by the system at send time.
- Write plainly, like a small local business owner — warm, direct, zero corporate filler, no emoji unless the existing text already uses them.
- Output ONLY the requested text. No preamble, no quotes around it, no explanations, no markdown headings.`

const trunc = (s: string | null | undefined, n: number) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// A compact, prompt-ready sketch of a customer's relationship — the shared
// context block for message drafts and the summary. Bounded queries only.
async function customerContext(supabase: SupabaseClient, userId: string, customerId: string, opts?: { deep?: boolean }) {
  const [custRes, jobsRes, quotesRes, invRes, bizRes] = await Promise.all([
    supabase.from('customers').select('name, address, city, notes, tags, created_at, sms_opt_in, email_opt_in, last_contacted_at, review_rating, reviewed_at')
      .eq('user_id', userId).eq('id', customerId).maybeSingle(),
    supabase.from('jobs').select('title, service_type, scheduled_date, status, price, notes')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('scheduled_date', { ascending: false }).limit(opts?.deep ? 25 : 8),
    supabase.from('quotes').select('quote_number, service_type, status, total, created_at')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(opts?.deep ? 10 : 4),
    supabase.from('invoices').select('invoice_number, status, amount, amount_paid, due_date, created_at')
      .eq('user_id', userId).eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(opts?.deep ? 10 : 4),
    supabase.from('business_settings').select('company_name').eq('user_id', userId).maybeSingle(),
  ])
  const c = custRes.data as { name: string; address: string | null; city: string | null; notes: string | null; tags: string[] | null; created_at: string; sms_opt_in: boolean; email_opt_in: boolean; last_contacted_at?: string | null; review_rating?: number | null; reviewed_at?: string | null } | null
  if (!c) return null
  const jobs = (jobsRes.data as Array<{ title: string; service_type: string | null; scheduled_date: string; status: string; price: number | null; notes: string | null }> | null) || []
  const quotes = (quotesRes.data as Array<{ quote_number: string; service_type: string; status: string; total: number; created_at: string }> | null) || []
  const invoices = (invRes.data as Array<{ invoice_number: string; status: string; amount: number; amount_paid: number | null; due_date: string | null; created_at: string }> | null) || []
  const company = (bizRes.data as { company_name: string | null } | null)?.company_name || 'the business'

  const lines: string[] = []
  lines.push(`Customer: ${c.name}${c.city ? ` (${c.city})` : ''} — customer since ${c.created_at.slice(0, 10)}.`)
  if (c.tags?.length) lines.push(`Tags: ${c.tags.slice(0, 6).join(', ')}.`)
  if (c.notes) lines.push(`Owner's notes: ${trunc(c.notes, 300)}`)
  if (c.last_contacted_at) lines.push(`Last contacted: ${String(c.last_contacted_at).slice(0, 10)}.`)
  if (c.reviewed_at) lines.push(`Left a ${c.review_rating ?? '?'}-star review on ${String(c.reviewed_at).slice(0, 10)}.`)
  if (jobs.length) {
    lines.push('Recent visits (newest first):')
    for (const j of jobs) lines.push(`  - ${j.scheduled_date} · ${j.service_type || j.title} · ${j.status}${j.price != null ? ` · $${j.price}` : ''}${j.notes ? ` · ${trunc(j.notes, 80)}` : ''}`)
  }
  if (quotes.length) lines.push(`Quotes: ${quotes.map(q => `#${q.quote_number} ${q.service_type} ${q.status} $${q.total}`).join('; ')}.`)
  const owing = invoices.filter(i => i.status !== 'paid' && i.status !== 'cancelled')
  if (owing.length) lines.push(`Open invoices: ${owing.map(i => `#${i.invoice_number} ${i.status} $${i.amount}${i.due_date ? ` due ${i.due_date}` : ''}`).join('; ')}.`)
  return { block: lines.join('\n'), company, name: c.name, firstName: c.name.split(' ')[0] }
}

async function businessName(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data } = await supabase.from('business_settings').select('company_name').eq('user_id', userId).maybeSingle()
  return (data as { company_name: string | null } | null)?.company_name || 'the business'
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
      const intent = trunc(p.template, 40) || 'custom'
      let context = ''
      let company = ''
      if (p.customerId && !p.bulk) {
        const ctx = await customerContext(supabase, userId, p.customerId)
        if (!ctx) throw new Error('customer not found')
        context = ctx.block
        company = ctx.company
      } else {
        company = await businessName(supabase, userId)
      }
      const rewrite = !!trunc(p.currentText, 10)
      const system = `You write customer messages for ${company}, a small local property-services company. ${
        smsOnly
          ? 'This goes out as a TEXT MESSAGE: 1–3 short sentences, under 300 characters, no greeting-line/sign-off formatting.'
          : 'This may go out as a text and an email body: keep it under 500 characters, a few short sentences, no subject line.'
      }${p.bulk ? '\nThis exact text goes to MANY customers at once — no personal names or per-customer details.' : ''}\n${GUARDRAILS}`
      const prompt = [
        context ? `Context about the recipient:\n${context}\n` : '',
        `Message intent: "${intent.replace(/_/g, ' ')}".`,
        p.instruction ? `The owner's instruction: ${trunc(p.instruction, 400)}` : '',
        rewrite
          ? `Rewrite the following draft — keep its meaning and every factual detail, improve clarity and warmth:\n---\n${trunc(p.currentText, 1500)}\n---`
          : 'Write the message.',
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 400, model: tiered('balanced') }
    }

    case 'customer_summary': {
      if (!p.customerId) throw new Error('customerId required')
      const ctx = await customerContext(supabase, userId, p.customerId, { deep: true })
      if (!ctx) throw new Error('customer not found')
      const system = `You brief the owner of ${ctx.company}, a small property-services company, on one customer before a call or visit. Write 4–7 short bullet lines (each starting with "- "): who they are, the relationship (how long, how often, what services), money (revenue, anything owing), anything that needs attention, and ONE suggested next action grounded in the data. Be specific with dates and amounts from the data — and only from the data.\n${GUARDRAILS}`
      const prompt = `Here is everything on file:\n${ctx.block}\n\nWrite the brief.`
      return { system, prompt, maxTokens: 500, model: tiered('smart') }
    }

    case 'review_response': {
      if (!p.customerId) throw new Error('customerId required')
      const ctx = await customerContext(supabase, userId, p.customerId)
      if (!ctx) throw new Error('customer not found')
      const rating = Math.min(5, Math.max(1, Math.round(p.rating || 5)))
      const system = `You write the business owner's PUBLIC reply to a customer review of ${ctx.company} (posted on ${trunc(p.source, 30) || 'Google'}). 2–4 sentences. ${
        rating >= 4
          ? 'It was a positive review: thank them genuinely and specifically (first name only), reference the kind of work done if known, and welcome them back. No discounts or incentives.'
          : 'It was a critical review: thank them for the feedback, apologize without excuses or arguing, and invite them to continue the conversation directly (phone/email) to make it right. Never dispute details publicly and never mention compensation.'
      }\n${GUARDRAILS}`
      const prompt = `Reviewer: ${ctx.firstName}. Rating: ${rating}/5.\nWhat we know about them:\n${ctx.block}\n\nWrite the public reply.`
      return { system, prompt, maxTokens: 300, model: tiered('balanced') }
    }

    case 'quote_scope': {
      const company = await businessName(supabase, userId)
      const propCtx = p.propertyId ? await getPropertyContext(supabase, p.propertyId) : null
      const propLine = propertyContextBlock(propCtx)
      const services = (p.services || []).map(s => trunc(s.name, 60)).filter(Boolean)
      const system = `You write the scope-of-work notes on a quote from ${company}, a small property-services company. Write 2–5 short sentences a homeowner immediately understands: what will be done, and anything worth setting expectations on. NEVER state or estimate any price, total, or hourly rate — pricing lives elsewhere on the quote. No bullet points unless the draft already uses them.\n${GUARDRAILS}`
      const prompt = [
        p.serviceType ? `Service: ${trunc(p.serviceType, 60)}.` : '',
        services.length ? `Line items on the quote: ${services.join('; ')}.` : '',
        propLine,
        trunc(p.draft, 10) ? `The owner's rough notes to build from:\n---\n${trunc(p.draft, 1200)}\n---` : 'Write the scope notes.',
      ].filter(Boolean).join('\n')
      return { system, prompt, maxTokens: 350, model: tiered('smart') }
    }

    case 'job_notes': {
      if (!trunc(p.draft, 3)) throw new Error('nothing to clean up')
      const company = await businessName(supabase, userId)
      const system = `You clean up rough job notes for ${company}, a small property-services company. Turn the jottings into clear, professional notes for the job record: keep EVERY fact (gate codes, access instructions, requests, measurements) exactly as given, fix grammar/shorthand, group related points. Same or shorter length.\n${GUARDRAILS}`
      const prompt = `Rough notes:\n---\n${trunc(p.draft, 2000)}\n---\nRewrite them.`
      return { system, prompt, maxTokens: 400, model: tiered('fast') }
    }
  }
}
