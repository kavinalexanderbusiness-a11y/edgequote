'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Quote } from '@/types'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { formatCurrency } from '@/lib/utils'
import { needsFollowUp, compareFollowUp, daysSince, logFollowUpPatch, markWonPatch } from '@/lib/followup'
import { Bell, Phone, MessageSquare, Check, X, RotateCw } from 'lucide-react'

type FollowUpQuote = Quote & { customers?: { id: string; name: string; phone: string | null } | null }

// Sent quotes that have gone quiet — the most recoverable revenue you already
// earned the right to. Priority: oldest first, then highest value.
export function FollowUpQuotes() {
  const supabase = createClient()
  const [quotes, setQuotes] = useState<FollowUpQuote[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      const { data } = await supabase
        .from('quotes')
        .select('*, customers(id, name, phone)')
        .eq('user_id', user!.id)
        .eq('status', 'sent')
      const list = ((data as FollowUpQuote[]) || []).filter(needsFollowUp).sort(compareFollowUp)
      setQuotes(list)
      setLoading(false)
    }
    load()
  }, [])

  async function patch(q: FollowUpQuote, updates: Record<string, unknown>) {
    setBusy(q.id)
    await supabase.from('quotes').update(updates).eq('id', q.id)
    setQuotes(prev => prev.filter(x => x.id !== q.id))
    setBusy(null)
  }

  const total = quotes.reduce((sum, q) => sum + Number(q.total || 0), 0)

  if (loading || quotes.length === 0) return null

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Bell className="w-4 h-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-ink">Quotes Needing Follow-Up</h2>
        <span className="text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">{quotes.length}</span>
        <span className="ml-auto text-sm font-bold text-accent">Potential: {formatCurrency(total)}</span>
      </CardHeader>
      <CardBody className="p-0">
        <div className="divide-y divide-border">
          {quotes.map(q => {
            const sent = daysSince(q.sent_at)
            const phone = q.customers?.phone
            return (
              <div key={q.id} className="px-4 sm:px-5 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/dashboard/quotes/${q.id}`} className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink truncate">{q.customer_name}</p>
                    <p className="text-xs text-ink-muted truncate mt-0.5">
                      {q.quote_number} · {q.service_type}
                      {sent != null && <> · sent {sent}d ago</>}
                      {q.follow_up_count > 0 && <> · {q.follow_up_count} follow-up{q.follow_up_count !== 1 ? 's' : ''}</>}
                    </p>
                  </Link>
                  <span className="text-sm font-bold text-ink shrink-0">{formatCurrency(Number(q.total))}</span>
                </div>

                {/* One-tap actions — large targets for mobile */}
                <div className="grid grid-cols-5 gap-1.5 mt-2.5">
                  <a
                    href={phone ? `tel:${phone}` : undefined}
                    aria-disabled={!phone}
                    className={`h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium border transition-colors ${phone ? 'bg-accent/10 border-accent/20 text-accent hover:bg-accent/20' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}
                  >
                    <Phone className="w-4 h-4" /> Call
                  </a>
                  <a
                    href={phone ? `sms:${phone}` : undefined}
                    aria-disabled={!phone}
                    className={`h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium border transition-colors ${phone ? 'bg-surface border-border text-ink hover:border-border-strong' : 'border-border text-ink-faint pointer-events-none opacity-40'}`}
                  >
                    <MessageSquare className="w-4 h-4" /> Text
                  </a>
                  <button
                    onClick={() => patch(q, logFollowUpPatch(q))}
                    disabled={busy === q.id}
                    className="h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium border border-border bg-surface text-ink hover:border-border-strong transition-colors disabled:opacity-50"
                  >
                    <RotateCw className="w-4 h-4" /> Followed
                  </button>
                  <button
                    onClick={() => patch(q, markWonPatch(q.follow_up_count))}
                    disabled={busy === q.id}
                    className="h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium border border-emerald-500/25 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                  >
                    <Check className="w-4 h-4" /> Won
                  </button>
                  <button
                    onClick={() => patch(q, { status: 'declined' })}
                    disabled={busy === q.id}
                    className="h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium border border-border bg-surface text-ink-muted hover:text-red-400 transition-colors disabled:opacity-50"
                  >
                    <X className="w-4 h-4" /> Lost
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </CardBody>
    </Card>
  )
}
