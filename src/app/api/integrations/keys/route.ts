// POST /api/integrations/keys — mint an API key for the signed-in owner.
// Server-side so the plaintext exists in exactly one place: this response.
// The row stores prefix + sha256 hash only; revoke/delete are client-side RLS.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateApiKey, hashApiKey, displayPrefix, normalizeScopes } from '@/lib/integrations/keys'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'API key'
  const scopes = normalizeScopes(body.scopes)
  if (!scopes) return NextResponse.json({ error: "scopes must be a non-empty subset of ['read','write']" }, { status: 422 })

  const rawKey = generateApiKey()
  const { data, error } = await supabase.from('api_keys').insert({
    user_id: user.id, name, prefix: displayPrefix(rawKey), key_hash: hashApiKey(rawKey), scopes,
  }).select('id, name, prefix, scopes, created_at').single()
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'insert failed' }, { status: 500 })

  return NextResponse.json({ ...data, key: rawKey }, { status: 201 })
}
