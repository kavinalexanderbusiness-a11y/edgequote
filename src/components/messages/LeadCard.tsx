'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { WebsiteLead, leadToPrefill, LEAD_PREFILL_KEY } from '@/lib/leads'
import { LeadSummary } from '@/components/leads/LeadSummary'
import { Button } from '@/components/ui/Button'
import { FileText } from 'lucide-react'

// The "Website Lead" card shown at the top of a website-lead conversation. Fetches
// the newest new lead for the customer and renders the shared LeadSummary (so it
// looks identical to the customer-profile view), plus a prominent Build Quote
// button that opens the Quote Builder pre-filled (via the eq_lead_prefill handoff).
export function LeadCard({ customerId }: { customerId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [lead, setLead] = useState<WebsiteLead | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      const { data } = await supabase.from('website_leads')
        .select('*').eq('customer_id', customerId).eq('status', 'new')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (active) { setLead((data as WebsiteLead | null) ?? null); setLoading(false) }
    })()
    return () => { active = false }
  }, [customerId, supabase])

  function buildQuote() {
    if (!lead) return
    try { window.sessionStorage.setItem(LEAD_PREFILL_KEY, JSON.stringify(leadToPrefill(lead))) } catch { /* ignore */ }
    router.push('/dashboard/quotes/new')
  }

  if (loading || !lead) return null

  return (
    <LeadSummary lead={lead} className="mb-3" footer={
      <>
        <Button size="sm" onClick={buildQuote} className="w-full sm:w-auto">
          <FileText className="w-4 h-4" /> Build Quote
        </Button>
        <p className="text-[10px] text-ink-faint mt-1.5">Opens the Quote Builder pre-filled — review, adjust the price, and create.</p>
      </>
    } />
  )
}
