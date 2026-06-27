import { NextRequest, NextResponse } from 'next/server'
import { submitLead, normalizeFormspree } from '@/lib/intake'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Formspree → EdgeQuote. Point a Formspree form's JSON webhook/redirect at this
// URL with the owner's booking token (?token=… or a hidden `token` field). The
// form fields are flattened and routed through the shared intake pipeline with
// source 'Formspree' — the lead appears instantly as a customer + property + lead.

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }
  const b = body as Record<string, unknown>
  const token = String(new URL(req.url).searchParams.get('token') || b.token || b._token || '')
  const payload = normalizeFormspree(b)

  const r = await submitLead({ token, source: 'Formspree', payload })
  return NextResponse.json(r.body, { status: r.status })
}
