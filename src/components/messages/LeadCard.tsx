'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { WebsiteLead, leadToPrefill, LEAD_PREFILL_KEY, closeOpenLeads } from '@/lib/leads'
import { LeadSummary } from '@/components/leads/LeadSummary'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { toast } from '@/lib/toast'
import { Skeleton } from '@/components/ui/Skeleton'
import { FileText, X, AlertTriangle } from 'lucide-react'

// The "Website lead" card shown at the top of a website-lead conversation. Fetches
// the newest new lead for the customer and renders the shared LeadSummary (so it
// looks identical to the customer-profile view), plus a prominent Build Quote
// button that opens the Quote Builder pre-filled (via the eq_lead_prefill handoff).
export function LeadCard({ customerId }: { customerId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [lead, setLead] = useState<WebsiteLead | null>(null)
  const [loading, setLoading] = useState(true)
  // A failed read is NOT "no lead". This card is the conversation's only lead
  // detail AND its only quote door (the header CTA hides while lead_status is
  // 'new', deferring to this card) — swallowing the error used to render the
  // thread as if the lead never existed, with no signal and no way in.
  const [loadError, setLoadError] = useState(false)
  const [building, setBuilding] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [uid, setUid] = useState<string | null>(null)

  const fetchLead = useCallback(async () => {
    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()
    setUid(session?.user?.id ?? null)
    const { data, error } = await supabase.from('website_leads')
      .select('*').eq('customer_id', customerId).eq('status', 'new')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    setLoadError(!!error)
    setLead(error ? null : ((data as WebsiteLead | null) ?? null))
    setLoading(false)
  }, [customerId, supabase])

  useEffect(() => { fetchLead() }, [fetchLead])

  function buildQuote() {
    if (!lead) return
    setBuilding(true)
    let carried = true
    try { window.sessionStorage.setItem(LEAD_PREFILL_KEY, JSON.stringify(leadToPrefill(lead))) }
    catch { carried = false }
    if (carried) {
      toast('Opening the Quote Builder…', { tone: 'info' })
      router.push('/dashboard/quotes/new')
    } else {
      // Storage refused (private mode, quota). Say so — a silently EMPTY builder
      // reads as a bug — and still open it on the right customer: the save path
      // closes leads by customer, so the badge clears even without the handoff.
      toast.error('Couldn’t carry the lead details over — the builder opens on the customer, but re-check the address and price against this card.')
      router.push(`/dashboard/quotes/new?customer=${lead.customer_id ?? customerId}`)
    }
  }

  // The other exit. Build-quote used to be the ONLY action, so a lead the owner
  // won't quote (wrong area, spam, changed their mind) nagged forever — the one
  // way to clear the badge was to manufacture a quote nobody wanted.
  async function dismiss() {
    if (!lead || !uid) return
    setDismissing(true)
    const res = await closeOpenLeads(supabase, {
      userId: uid, customerIds: [lead.customer_id ?? customerId], status: 'dismissed', leadId: lead.id,
    })
    setDismissing(false)
    if (!res.ok) { toast.error('Could not dismiss the lead: ' + res.error); return }
    setLead(null)
    toast.success('Lead dismissed — the conversation stays.')
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
  if (loadError) return (
    <Banner tone="warn" icon={AlertTriangle} className="mb-3"
      action={<Button size="sm" variant="secondary" onClick={fetchLead}>Retry</Button>}>
      Couldn’t load this lead’s details — the request itself still exists.
    </Banner>
  )
  if (!lead) return null

  return (
    <LeadSummary lead={lead} className="mb-3" footer={
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={buildQuote} loading={building} className="w-full sm:w-auto">
            <FileText className="w-4 h-4" /> Build quote
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss} loading={dismissing}
            className="text-ink-faint hover:text-ink" title="Close this lead without quoting — the conversation stays">
            <X className="w-3.5 h-3.5" /> Dismiss
          </Button>
        </div>
        <p className="text-[11px] text-ink-muted mt-1.5">Opens the Quote Builder pre-filled — review, adjust the price, and create.</p>
      </>
    } />
  )
}
