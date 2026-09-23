'use client'

import { useMemo, useState } from 'react'
import { CalendarCheck2, ShieldCheck } from 'lucide-react'
import type { Quote, QuoteService } from '@/types'
import { createClient } from '@/lib/supabase/client'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/Button'

function objectMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function PublicSchedulingApproval({ quote, services }: { quote: Quote; services: QuoteService[] }) {
  const supabase = useMemo(() => createClient(), [])
  const meta = objectMeta(quote.lead_meta)
  const [approved, setApproved] = useState(
    meta.route_eligibility === 'approved'
      && typeof meta.route_eligibility_approved_at === 'string'
      && typeof meta.scheduling_inputs_confirmed_at === 'string',
  )
  const [busy, setBusy] = useState(false)
  const missing = [
    !quote.property_id ? 'verified property' : null,
    Number(quote.hours || 0) <= 0 ? 'duration' : null,
    Number(quote.crew_size || 0) <= 0 ? 'crew size' : null,
    services.slice(1).some(s => Number(s.est_minutes || 0) <= 0) ? 'additional-service duration' : null,
  ].filter(Boolean) as string[]

  async function setApproval(next: boolean) {
    if (busy || (next && missing.length > 0)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('set_public_quote_scheduling_approval', {
      p_quote_id: quote.id,
      p_approved: next,
    })
    setBusy(false)
    const result = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown> : {}
    const state = String(result.state || '')
    if (error || (next ? state !== 'approved' : state !== 'review_required')) {
      const details = Array.isArray(result.missing) ? result.missing.join(' ') : ''
      toast.error(details || 'Could not update public scheduling approval. Nothing changed.')
      return
    }
    setApproved(next)
    toast.success(next ? 'Route, duration and crew approved for customer scheduling.' : 'Customer scheduling approval removed.')
  }

  return (
    <div className="pt-4 border-t border-border">
      <div className="rounded-xl border border-border bg-bg-secondary p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-ink flex items-center gap-1.5">
              {approved ? <ShieldCheck className="w-4 h-4 text-emerald-400" /> : <CalendarCheck2 className="w-4 h-4 text-accent-text" />}
              Customer self-scheduling
            </p>
            <p className="text-xs text-ink-muted mt-1">
              {approved
                ? 'This address and route are eligible, and the displayed duration and crew are confirmed.'
                : 'Confirm these facts before an accepted, deposit-cleared quote may show live dates.'}
            </p>
          </div>
          <span className={`text-[10px] font-semibold uppercase tracking-wide rounded-full border px-2 py-1 ${approved ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/30 bg-amber-500/10 text-amber-400'}`}>
            {approved ? 'Approved' : 'Review required'}
          </span>
        </div>
        {missing.length > 0 && !approved && (
          <p className="text-xs text-amber-400 mt-3">Complete: {missing.join(', ')}.</p>
        )}
        <p className="text-[11px] text-ink-faint mt-2">Editing the address, property, duration, crew or service lines removes this approval automatically.</p>
        <div className="mt-3">
          <Button type="button" size="sm" variant={approved ? 'secondary' : 'primary'} loading={busy}
            disabled={busy || (!approved && missing.length > 0)} onClick={() => setApproval(!approved)}>
            {approved ? 'Remove approval' : 'Approve route, duration & crew'}
          </Button>
        </div>
      </div>
    </div>
  )
}
