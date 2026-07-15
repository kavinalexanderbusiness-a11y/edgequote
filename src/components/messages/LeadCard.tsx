'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { WebsiteLead, leadToPrefill, LEAD_PREFILL_KEY } from '@/lib/leads'
import { LeadSummary } from '@/components/leads/LeadSummary'
import { Button } from '@/components/ui/Button'
import { toast } from '@/lib/toast'
import { Skeleton } from '@/components/ui/Skeleton'
import { FileText } from 'lucide-react'

// The "Website lead" card shown at the top of a website-lead conversation. Fetches
// the newest new lead for the customer and renders the shared LeadSummary (so it
// looks identical to the customer-profile view), plus a prominent Build Quote
// button that opens the Quote Builder pre-filled (via the eq_lead_prefill handoff).
export function LeadCard({ customerId }: { customerId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [lead, setLead] = useState<WebsiteLead | null>(null)
  const [loading, setLoading] = useState(true)
  const [building, setBuilding] = useState(false)

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
    setBuilding(true)
    try { window.sessionStorage.setItem(LEAD_PREFILL_KEY, JSON.stringify(leadToPrefill(lead))) } catch { /* ignore */ }
    toast('Opening the Quote Builder…', { tone: 'info' })
    router.push('/dashboard/quotes/new')
  }

  // Reserve the card's space while the lead loads so the conversation header doesn't jump.
  if (loading) return (
    <div className="rounded-card border border-accent/20 bg-accent/[0.04] p-3.5 mb-3 space-y-2.5">
      <Skeleton className="h-3.5 w-32" />
      <Skeleton className="h-7 w-28" />
      <div className="space-y-1.5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-3.5 w-full" />)}</div>
      <Skeleton className="h-8 w-32" />
    </div>
  )
  if (!lead) return null

  return (
    <LeadSummary lead={lead} className="mb-3" footer={
      <>
        <Button size="sm" onClick={buildQuote} loading={building} className="w-full sm:w-auto">
          <FileText className="w-4 h-4" /> Build quote
        </Button>
        <p className="text-[11px] text-ink-muted mt-1.5">Opens the Quote Builder pre-filled — review, adjust the price, and create.</p>
      </>
    } />
  )
}
