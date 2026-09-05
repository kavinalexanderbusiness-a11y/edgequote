import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// ── GET /api/register/status → { open: boolean } ─────────────────────────────
// The ONE public fact about self-service registration. The switch itself
// (public.platform_registration) is service-role only — RLS on, zero policies,
// unreadable to anon and authenticated — so the sign-up page cannot ask the
// database and must ask here. This route reads it on the server and says
// open or closed, nothing else: not when, not why, not who.
//
// Fails CLOSED. No service key, a read error, a missing row — every one of them
// is "closed", because the database would refuse the sign-up anyway and a page
// that promised otherwise would be lying to the person filling in the form.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  let open = false
  const admin = createAdminClient()
  if (admin) {
    const { data, error } = await admin
      .from('platform_registration').select('self_service_open').eq('id', true).maybeSingle()
    open = !error && (data as { self_service_open: boolean } | null)?.self_service_open === true
  }
  return NextResponse.json({ open }, { headers: { 'Cache-Control': 'no-store' } })
}
