'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Quote } from '@/types'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { CalendarPlus, AlertCircle } from 'lucide-react'

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Accepted quotes that have no job on the calendar yet — the things most at
// risk of falling through the cracks. One tap drops them on today's schedule.
export function UnscheduledAccepted() {
  const supabase = createClient()
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [loading, setLoading] = useState(true)
  const [scheduling, setScheduling] = useState<string | null>(null)

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    const [qRes, jRes] = await Promise.all([
      supabase.from('quotes').select('*').eq('user_id', user!.id).eq('status', 'accepted').order('created_at', { ascending: false }),
      supabase.from('jobs').select('quote_id').eq('user_id', user!.id).not('quote_id', 'is', null),
    ])
    const scheduled = new Set((jRes.data || []).map((j: { quote_id: string | null }) => j.quote_id))
    setQuotes(((qRes.data as Quote[]) || []).filter(q => !scheduled.has(q.id)))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function quickSchedule(q: Quote) {
    setScheduling(q.id)
    const { data: { user } } = await supabase.auth.getUser()
    let propertyId: string | null = q.property_id
    if (!propertyId && q.customer_id) {
      const { data: props } = await supabase
        .from('properties').select('id').eq('customer_id', q.customer_id)
        .order('is_primary', { ascending: false }).limit(1)
      if (props && props.length > 0) propertyId = props[0].id
    }
    await supabase.from('jobs').insert({
      user_id: user!.id,
      customer_id: q.customer_id,
      property_id: propertyId,
      quote_id: q.id,
      title: `${q.service_type} — ${q.customer_name}`,
      service_type: q.service_type,
      scheduled_date: localToday(),
      duration_minutes: Math.round(Number(q.hours) * 60),
      crew_size: q.crew_size,
      status: 'scheduled',
      notes: q.notes,
    })
    await supabase.from('quotes').update({ status: 'scheduled' }).eq('id', q.id)
    setQuotes(prev => prev.filter(x => x.id !== q.id))
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
