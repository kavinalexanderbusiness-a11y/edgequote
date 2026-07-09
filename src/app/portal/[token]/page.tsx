import { createClient } from '@/lib/supabase/server'
import { PortalClient } from './PortalClient'

// The portal is per-token live data — never statically cached.
export const dynamic = 'force-dynamic'

// Server-first: resolve the token and fetch get_portal_data SERVER-SIDE (the token RPC is
// anon-accessible — no user session needed), so the customer's first paint is real content
// instead of a bundle→hydrate→fetch→spinner chain. PortalClient normalizes the raw payload
// and reuses the exact same UI + RPCs; it revalidates client-side only after a payment /
// card save (?paid / ?cardsaved).
export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let initialData: unknown = null
  try {
    const supabase = await createClient()
    const { data } = await supabase.rpc('get_portal_data', { p_token: token })
    initialData = data ?? null
  } catch {
    // Network/RPC hiccup at request time → hand null down; PortalClient fetches as a fallback.
  }
  return <PortalClient token={token} initialData={initialData} />
}
