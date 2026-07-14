import { createClient } from '@supabase/supabase-js'

// ── Shared lead intake ───────────────────────────────────────────────────────
// THE single server-side door for turning ANY external submission (website
// contact / quote / booking forms, Formspree, a generic webhook, future
// integrations) into a customer + property + lead inside EdgeQuote. Every source
// funnels through the SAME submit_website_lead pipeline (dedup customer by
// phone→email→address, create/match property, write the lead, thread it into
// Messages, notify the owner) — only the `source` (acquisition_source) differs.
// No business logic is duplicated here; this just normalizes + forwards.

export interface IntakeResult {
  ok: boolean
  status: number
  body: Record<string, unknown>
}

// Flatten a Formspree submission. Formspree posts the form fields as top-level
// JSON; some setups nest them under `data`/`fields`. Field-name aliases
// (firstName/first_name, address/serviceAddress, …) are resolved INSIDE the RPC,
// so we only need to surface the right object here.
export function normalizeFormspree(body: Record<string, unknown>): Record<string, unknown> {
  const nested = (body.data && typeof body.data === 'object')
    ? body.data
    : (body.fields && typeof body.fields === 'object') ? body.fields : null
  const out: Record<string, unknown> = nested ? { ...(nested as Record<string, unknown>) } : { ...body }
  delete out.token; delete out._token; delete out.source
  // Formspree metadata we never want to persist as lead fields.
  delete out._gotcha; delete out._subject; delete out._replyto
  return out
}

// Submit a normalized lead through the shared pipeline. `source` becomes the
// customer's acquisition_source (e.g. 'Website', 'Formspree', 'Website Booking').
export async function submitLead(opts: {
  token: string
  source?: string
  payload: Record<string, unknown>
}): Promise<IntakeResult> {
  const token = (opts.token || '').trim()
  if (!token) return { ok: false, status: 400, body: { error: 'missing token' } }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return { ok: false, status: 500, body: { error: 'intake not configured' } }

  const anon = createClient(url, key)
  const { data, error } = await anon.rpc('submit_website_lead', {
    p_token: token,
    p_payload: opts.payload,
    p_source: (opts.source || 'Website').trim() || 'Website',
  })

  if (error) {
    console.error('[intake] rpc error:', error.message)
    return { ok: false, status: 502, body: { error: 'Could not submit your request. Please try again.' } }
  }
  if (!data) return { ok: false, status: 404, body: { error: 'This form is not currently accepting submissions.' } }

  const result = data as { error?: string; lead_id?: string; customer_id?: string; source?: string }
  if (result.error === 'rate_limited') {
    return { ok: false, status: 429, body: { error: 'Too many requests — please try again shortly.' } }
  }
  return { ok: true, status: 200, body: { ok: true, ...result } }
}
