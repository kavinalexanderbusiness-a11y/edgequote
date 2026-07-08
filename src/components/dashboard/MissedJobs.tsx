'use client'
import { toast } from '@/lib/toast'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@/lib/utils'
import { jobVisitValue, effectiveFreq, createDraftInvoiceForCompletedJob } from '@/lib/invoicing'
import type { Job } from '@/types'
import { AlertTriangle, Check, CalendarClock } from 'lucide-react'

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface MissedRow {
  id: string
  title: string
  customer_name: string
  service_type: string | null
  scheduled_date: string
  value: number
  job: Job // enough fields for the completion → draft-invoice flow
}

// Past-date jobs still marked scheduled/in_progress — work that silently slipped.
// For a 3-day/week operator this is the quiet leak: skipped visits go un-invoiced
// (draft invoices only fire on completion) and recurring customers fall behind.
export function MissedJobs() {
  const supabase = createClient()
  const [rows, setRows] = useState<MissedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    // Local session read — no auth round-trip before the RLS-scoped queries below.
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    const today = localToday()
    const [jRes, qRes, rRes] = await Promise.all([
      supabase.from('jobs')
        .select('*, customers(name)')
        .eq('user_id', user!.id)
        .lt('scheduled_date', today)
        .in('status', ['scheduled', 'in_progress'])
        .order('scheduled_date', { ascending: true }),
      supabase.from('quotes').select('id, total, initial_price, weekly_price, biweekly_price, monthly_price').eq('user_id', user!.id),
      supabase.from('job_recurrences').select('id, freq, interval_unit, interval_count').eq('user_id', user!.id),
    ])
    const quotesById: Record<string, Record<string, unknown>> = {}
    for (const q of (qRes.data as Record<string, unknown>[]) || []) quotesById[q.id as string] = q
    const recById: Record<string, { freq: string | null; interval_unit: string | null; interval_count: number | null }> = {}
    for (const r of (rRes.data as { id: string; freq: string | null; interval_unit: string | null; interval_count: number | null }[]) || []) recById[r.id] = r

    setRows(((jRes.data as unknown as (Job & { customers?: { name: string } | null })[]) || []).map(j => {
      const quote = j.quote_id ? quotesById[j.quote_id] : null
      const rec = j.recurrence_id ? recById[j.recurrence_id] : null
      const freq = rec ? effectiveFreq(rec.freq, rec.interval_unit, rec.interval_count) : null
      return {
        id: j.id, title: j.title, customer_name: j.customers?.name || j.title,
        service_type: j.service_type, scheduled_date: j.scheduled_date,
        value: Math.round(jobVisitValue(j.price, quote, freq)), job: j,
      }
    }))
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function markDone(row: MissedRow) {
    setBusy(row.id)
    await supabase.from('jobs').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', row.id)
    if (row.job.recurrence_id) await createDraftInvoiceForCompletedJob(supabase, { ...row.job, status: 'completed' })
    setRows(prev => prev.filter(r => r.id !== row.id))
    setBusy(null)
  }
  async function moveToToday(row: MissedRow) {
    setBusy(row.id)
    // A weekly customer's THIS-week visit may already sit on today — moving the
    // missed one too would double-book (and double-invoice) the same customer.
    const j = row.job
    if (j.recurrence_id || j.customer_id) {
      let dup = supabase.from('jobs').select('id').eq('scheduled_date', localToday()).neq('status', 'cancelled').neq('id', j.id).limit(1)
      dup = j.recurrence_id ? dup.eq('recurrence_id', j.recurrence_id) : dup.eq('customer_id', j.customer_id as string)
      const { data: existing } = await dup
      if (existing && existing.length > 0) {
        toast.error('This customer already has a visit scheduled today. Mark this missed one Done if it was actually serviced, or delete it on the Schedule.')
        setBusy(null)
        return
      }
    }
    await supabase.from('jobs').update({ scheduled_date: localToday() }).eq('id', row.id)
    setRows(prev => prev.filter(r => r.id !== row.id))
    setBusy(null)
  }

  if (loading || rows.length === 0) return null
  const atRisk = rows.reduce((s, r) => s + r.value, 0)

  return (
    <Card className="border-red-500/30">
      <CardHeader className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <h2 className="text-sm font-semibold text-ink">Missed jobs — past date, still open</h2>
        <span className="ml-auto text-xs font-semibold text-red-400 bg-red-500/10 border border-red-500/20 rounded-full px-2 py-0.5">
          {rows.length} · {formatCurrency(atRisk)} at risk
        </span>
      </CardHeader>
      <CardBody className="p-0">
        <div className="divide-y divide-border">
          {rows.slice(0, 12).map(row => (
            <div key={row.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <Link href={`/dashboard/schedule`} className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink truncate">{row.customer_name}</p>
                <p className="text-xs text-ink-muted truncate mt-0.5">
                  {format(parseISO(row.scheduled_date + 'T00:00:00'), 'EEE, MMM d')}
                  {row.service_type ? ` · ${row.service_type}` : ''} · {row.value > 0 ? formatCurrency(row.value) : 'no price'}
                </p>
              </Link>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" variant="secondary" loading={busy === row.id} onClick={() => markDone(row)} title="Mark this visit done">
                  <Check className="w-3.5 h-3.5" /> Done
                </Button>
                <Button size="sm" variant="ghost" disabled={busy === row.id} onClick={() => moveToToday(row)} title="Reschedule to today">
                  <CalendarClock className="w-3.5 h-3.5" /> Today
                </Button>
              </div>
            </div>
          ))}
        </div>
        {rows.length > 12 && <p className="px-5 py-2 text-xs text-ink-faint">+{rows.length - 12} more — see Schedule.</p>}
      </CardBody>
    </Card>
  )
}
