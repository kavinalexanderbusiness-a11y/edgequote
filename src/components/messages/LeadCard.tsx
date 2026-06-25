'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { WebsiteLead, leadToPrefill, LEAD_PREFILL_KEY } from '@/lib/leads'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { Globe, Ruler, Sparkles, FileText, MapPin, Phone, Mail, Repeat } from 'lucide-react'

const FREQ_LABEL: Record<string, string> = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly', one_time: 'One-time' }

// The "Website Lead" card shown at the top of a website-lead conversation. Surfaces
// everything the website collected and a prominent Build Quote button that opens the
// Quote Builder pre-filled (via the eq_lead_prefill handoff).
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

  const est = Number(lead.website_estimated_price) || 0
  const freq = (lead.frequency || '').toLowerCase()
  const services = lead.requested_services
  const submitted = lead.submitted_at || lead.created_at

  return (
    <div className="rounded-card border border-accent/30 bg-accent/[0.06] p-3.5 mb-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-accent flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5" /> Website quote request
        </p>
        {submitted && <span className="text-[10px] text-ink-faint">{new Date(submitted).toLocaleDateString()}</span>}
      </div>

      {/* Contact */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {lead.phone && <span className="flex items-center gap-1 text-ink"><Phone className="w-3 h-3 text-ink-faint" /> {lead.phone}</span>}
        {lead.email && <span className="flex items-center gap-1 text-ink"><Mail className="w-3 h-3 text-ink-faint" /> {lead.email}</span>}
        {lead.preferred_contact && <span className="text-ink-muted">Prefers {lead.preferred_contact}</span>}
      </div>
      {lead.address && <p className="text-xs text-ink-muted flex items-center gap-1 mt-1"><MapPin className="w-3 h-3 text-ink-faint shrink-0" /> {lead.address}{lead.city ? `, ${lead.city}` : ''}</p>}

      {/* Measurement + request */}
      <div className="flex flex-wrap gap-1.5 mt-2.5">
        {lead.lawn_sqft ? <Chip icon={Ruler}>{Number(lead.lawn_sqft).toLocaleString()} ft² lawn</Chip> : null}
        {services ? <Chip icon={Sparkles}>{services}</Chip> : null}
        {freq && FREQ_LABEL[freq] ? <Chip icon={Repeat}>{FREQ_LABEL[freq]}</Chip> : null}
        {lead.yard_condition ? <Chip>{lead.yard_condition}</Chip> : null}
        {lead.travel_distance_km != null ? <Chip>{Number(lead.travel_distance_km).toFixed(1)} km</Chip> : null}
      </div>

      {/* Website estimate */}
      {est > 0 && (
        <div className="flex items-baseline gap-2 mt-2.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-faint">Website estimate</span>
          <span className="text-base font-bold text-ink">{formatCurrency(est)}{freq && FREQ_LABEL[freq] && freq !== 'one_time' ? <span className="text-xs font-medium text-ink-muted"> / visit</span> : null}</span>
        </div>
      )}

      {lead.notes && <p className="text-xs text-ink-muted mt-2 whitespace-pre-wrap border-l-2 border-border pl-2">{lead.notes}</p>}

      <div className="mt-3">
        <Button size="sm" onClick={buildQuote} className="w-full sm:w-auto">
          <FileText className="w-4 h-4" /> Build Quote
        </Button>
        <p className="text-[10px] text-ink-faint mt-1.5">Opens the Quote Builder pre-filled — review, adjust the price, and create.</p>
      </div>
    </div>
  )
}

function Chip({ icon: Icon, children }: { icon?: typeof Ruler; children: React.ReactNode }) {
  return (
    <span className="text-[11px] text-ink-muted bg-surface border border-border rounded px-1.5 py-0.5 flex items-center gap-1">
      {Icon && <Icon className="w-3 h-3 text-ink-faint" />} {children}
    </span>
  )
}
