import { createClient } from '@/lib/supabase/server'
import { BookingClient, type Biz } from './BookingClient'

// Per-token public funnel — never statically cached.
export const dynamic = 'force-dynamic'

// Server-first: resolve the token and fetch get_booking_business SERVER-SIDE (anon token
// RPC, no session needed) so the funnel's first step renders instantly instead of a
// bundle→hydrate→fetch→spinner chain. BookingClient reuses the exact same UI + RPCs.
export default async function BookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let initialBiz: Biz | null = null
  try {
    const supabase = await createClient()
    const { data } = await supabase.rpc('get_booking_business', { p_token: token })
    initialBiz = (data as Biz | null) ?? null
  } catch {
    // Network/RPC hiccup at request time → hand null down; BookingClient fetches as a fallback.
  }
  return <BookingClient token={token} initialBiz={initialBiz} />
}
