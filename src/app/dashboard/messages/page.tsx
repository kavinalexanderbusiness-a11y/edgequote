'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { MessageSquare, Loader2, Check, RotateCcw, FileText, User, Inbox } from 'lucide-react'

// ── Messages / Inbox ─────────────────────────────────────────────────────────
// Where customer messages & service requests from the portal land so the owner
// can actually READ and act on them. Reads the existing `service_requests` table
// (the portal's "Request" tab writes here via portal_request_service); does not
// touch the portal. One tap to mark handled, open the customer, or convert to a
// quote.

interface ReqRow {
  id: string
  created_at: string
  customer_id: string | null
  message: string
  status: string
  customers: { id: string; name: string; phone: string | null; email: string | null } | null
}

type Filter = 'all' | 'new' | 'handled'

export default function MessagesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<ReqRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('new')
  const [busyId, setBusyId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    const { data } = await supabase
      .from('service_requests')
      .select('id, created_at, customer_id, message, status, customers(id, name, phone, email)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    setRows((data as unknown as ReqRow[]) || [])
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function setStatus(r: ReqRow, status: string) {
    setBusyId(r.id)
    setRows(prev => prev.map(x => x.id === r.id ? { ...x, status } : x)) // optimistic
    await supabase.from('service_requests').update({ status }).eq('id', r.id)
    setBusyId(null)
  }

  const counts = useMemo(() => ({
    all: rows.length,
    new: rows.filter(r => r.status === 'new').length,
    handled: rows.filter(r => r.status !== 'new').length,
  }), [rows])

  const visible = filter === 'all' ? rows : filter === 'new' ? rows.filter(r => r.status === 'new') : rows.filter(r => r.status !== 'new')

  const FILTERS: { key: Filter; label: string }[] = [
    { key: 'new', label: `New${counts.new ? ` (${counts.new})` : ''}` },
    { key: 'all', label: `All (${counts.all})` },
    { key: 'handled', label: 'Handled' },
  ]

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Messages" description="Service requests and messages your customers send from their portal." />

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={cn('text-xs font-medium rounded-full px-3 py-1.5 border transition-colors',
              filter === f.key ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-ink-muted flex items-center justify-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading messages…
        </div>
      ) : visible.length === 0 ? (
        <div className="py-16 text-center">
          <Inbox className="w-10 h-10 text-ink-faint mx-auto mb-3" />
          <p className="text-sm font-medium text-ink">{filter === 'new' ? 'No new messages' : 'No messages yet'}</p>
          <p className="text-xs text-ink-muted mt-1">When a customer sends a request from their portal, it shows up here.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {visible.map(r => {
            const isNew = r.status === 'new'
            const name = r.customers?.name || 'Unknown customer'
            return (
              <div key={r.id} className={cn('rounded-card border p-4', isNew ? 'border-accent/30 bg-accent/[0.04]' : 'border-border bg-bg-secondary')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink flex items-center gap-2">
                      {isNew && <span className="w-2 h-2 rounded-full bg-accent shrink-0" />}
                      {name}
                    </p>
                    <p className="text-[11px] text-ink-faint mt-0.5">
                      {(() => { try { return formatDistanceToNow(new Date(r.created_at), { addSuffix: true }) } catch { return '' } })()}
                      {r.customers?.phone ? ` · ${r.customers.phone}` : ''}
                    </p>
                  </div>
                  <span className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 border',
                    isNew ? 'text-accent border-accent/30 bg-accent/10' : 'text-ink-muted border-border')}>
                    {isNew ? 'New' : 'Handled'}
                  </span>
                </div>

                <p className="text-sm text-ink mt-2.5 whitespace-pre-wrap">{r.message}</p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {isNew
                    ? <Button size="sm" onClick={() => setStatus(r, 'handled')} loading={busyId === r.id}><Check className="w-3.5 h-3.5" /> Mark handled</Button>
                    : <Button size="sm" variant="secondary" onClick={() => setStatus(r, 'new')} loading={busyId === r.id}><RotateCcw className="w-3.5 h-3.5" /> Reopen</Button>}
                  {r.customer_id && (
                    <Link href={`/dashboard/quotes/new?customer=${r.customer_id}`}>
                      <Button size="sm" variant="secondary"><FileText className="w-3.5 h-3.5" /> Convert to quote</Button>
                    </Link>
                  )}
                  {r.customer_id && (
                    <Link href={`/dashboard/customers/${r.customer_id}`}>
                      <Button size="sm" variant="ghost"><User className="w-3.5 h-3.5" /> View customer</Button>
                    </Link>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
