'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Quote } from '@/types'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { scheduleQuoteAsJob } from '@/lib/scheduleQuote'
import { toast } from '@/lib/toast'
import { CalendarPlus, AlertCircle } from 'lucide-react'

// Accepted quotes that have no job on the calendar yet — the things most at
// risk of falling through the cracks. One tap drops them on today's schedule.
// Preferred: fed by the dashboard's server load via `quotes` (no second client
// round-trip, no pop-in layout shift). Without the prop it self-fetches.
export function UnscheduledAccepted({ quotes: initialQuotes }: { quotes?: Quote[] }) {
  const supabase = createClient()
  const router = useRouter()
  const [quotes, setQuotes] = useState<Quote[]>(initialQuotes ?? [])
  const [loading, setLoading] = useState(!initialQuotes)
  const [scheduling, setScheduling] = useState<string | null>(null)

  // Dashboard passes `initialQuotes` (fetch-once) → skip the client fetch; otherwise
  // self-fetch. Local session read (getSession) — no auth round-trip.
  useEffect(() => {
    if (initialQuotes) return
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      const [qRes, jRes] = await Promise.all([
        supabase.from('quotes').select('*').eq('user_id', user!.id).eq('status', 'accepted').order('created_at', { ascending: false }),
        // Cancelled jobs must NOT count as "scheduled" — an accepted quote whose
        // only job was cancelled would otherwise vanish from this safety net.
        supabase.from('jobs').select('quote_id').eq('user_id', user!.id).not('quote_id', 'is', null).neq('status', 'cancelled'),
      ])
      const scheduled = new Set((jRes.data || []).map((j: { quote_id: string | null }) => j.quote_id))
      setQuotes(((qRes.data as Quote[]) || []).filter(q => !scheduled.has(q.id)))
      setLoading(false)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function quickSchedule(q: Quote) {
    setScheduling(q.id)
    const { data: { user } } = await supabase.auth.getUser()
    // THE quote→job engine (lib/scheduleQuote) — it fetches quote_services, so a
    // multi-service quote scheduled from this card keeps its add-ons, duration
    // and price, identical to scheduling from the quote page.
    const { error } = await scheduleQuoteAsJob(supabase, user!.id, q)
    if (error) {
      toast.error('Could not create job: ' + error)
    } else {
      setQuotes(prev => prev.filter(x => x.id !== q.id))
      // Dispatchers usually want to adjust crew/notes/time right away — one tap
      // to today's schedule, where the new job just landed.
      toast('Job added to today’s schedule.', {
        tone: 'success',
        action: { label: 'View job', run: () => router.push('/dashboard/schedule') },
      })
    }
    setScheduling(null)
  }

  // Only surface when there's something needing action.
  if (loading || quotes.length === 0) return null

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-ink">Accepted — not yet scheduled</h2>
        <span className="ml-auto text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-full px-2 py-0.5">{quotes.length}</span>
      </CardHeader>
      <CardBody className="p-0">
        <div className="divide-y divide-border">
          {quotes.map(q => (
            <div key={q.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <Link href={`/dashboard/quotes/${q.id}`} className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink truncate">{q.customer_name}</p>
                <p className="text-xs text-ink-muted truncate mt-0.5">{q.quote_number} · {q.service_type} · {formatCurrency(q.total)}</p>
              </Link>
              <Button size="sm" loading={scheduling === q.id} onClick={() => quickSchedule(q)}>
                <CalendarPlus className="w-3.5 h-3.5" /> Schedule today
              </Button>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}
