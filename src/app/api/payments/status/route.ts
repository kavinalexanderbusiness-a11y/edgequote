import { NextResponse } from 'next/server'
import { stripeEnabled, webhookConfigured } from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'

// Public booleans so the UI can hide Pay Now when payments aren't configured.
// No secrets leave the server — just whether the keys exist.
export async function GET() {
  return NextResponse.json({ enabled: stripeEnabled(), webhook: webhookConfigured() })
}
