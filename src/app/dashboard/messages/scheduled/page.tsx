'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { Modal } from '@/components/ui/Modal'
import { CustomerPicker } from '@/components/ui/CustomerPicker'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { SendMessageDialog } from '@/components/comms/SendMessageDialog'
import { MSG_LABELS, type MsgType } from '@/lib/comms/templates'
import { statusMeta, TONE_CLASS, type StatusMeta } from '@/lib/comms/logStatus'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { format } from 'date-fns'
import type { Customer } from '@/types'
import { CalendarClock, Clock, Ban, Mail, MessageSquare, Plus, X } from 'lucide-react'

// ── Scheduled messages: the send-later queue ───────────────────────────────────
// Rows are written by THE shared SendMessageDialog ("Send later") and sent by
// /api/cron/scheduled-messages through the same pipeline as every other send.
// This page only lists and cancels — it never sends anything itself. Consent is
// enforced at SEND time (inside dispatch), so a customer who opts out after
// scheduling is skipped, not messaged.

interface Row {
  id: string; created_at: string; customer_id: string; template: string
  channels: string[]; body: string | null; send_at: string
  status: string; sent_at: string | null; detail: string | null
  customers?: { name: string } | null
}

type Filter = 'upcoming' | 'sent' | 'unsent' | 'canceled'
const FILTER_STATUSES: Record<Filter, string[]> = {
  upcoming: ['pending', 'sending'],
  sent: ['sent'],
  unsent: ['skipped', 'failed'],
  canceled: ['canceled'],
}

export default function ScheduledMessagesPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('upcoming')
  const [counts, setCounts] = useState<Record<Filter, number>>({ upcoming: 0, sent: 0, unsent: 0, canceled: 0 })
  const seq = useRef(0)

  async function load() {
    const mySeq = ++seq.current
    setLoading(true)
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { if (mySeq === seq.current) setLoading(false); return }
    const upcoming = filter === 'upcoming'
    const [listRes, ...countRes] = await Promise.all([
      supabase.from('scheduled_messages')
        .select('id, created_at, customer_id, template, channels, body, send_at, status, sent_at, detail, customers(name)')
        .eq('user_id', uid).in('status', FILTER_STATUSES[filter])
        .order('send_at', { ascending: upcoming }).limit(100),
      ...(Object.keys(FILTER_STATUSES) as Filter[]).map(f =>
        supabase.from('scheduled_messages').select('id', { count: 'exact', head: true }).eq('user_id', uid).in('status', FILTER_STATUSES[f])),
    ])
    if (mySeq !== seq.current) return
    setRows((listRes.data as unknown as Row[]) || [])
    const keys = Object.keys(FILTER_STATUSES) as Filter[]
    setCounts(Object.fromEntries(keys.map((f, i) => [f, countRes[i]?.count || 0])) as Record<Filter, number>)
    setLoading(false)
  }
  useEffect(() => { load() }, [filter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel is a CAS on status — if the cron claimed the row first, zero rows
  // update and the truthful answer is "already being sent".
  async function cancel(r: Row) {
    const { data } = await supabase.from('scheduled_messages')
      .update({ status: 'canceled' }).eq('id', r.id).eq('status', 'pending').select('id')
    if ((data as unknown[] | null)?.length) {
      toast.success('Canceled — it won’t be sent.')
      load()
    } else {
      toast.error('Too late to cancel — this message is already being sent.')
      load()
    }
  }

  // ── Schedule a new message: pick a customer → THE shared composer, opened in
  // Send-later mode. Same two-step compose flow as the Inbox.
  const [pickOpen, setPickOpen] = useState(false)
  const [pickCustomers, setPickCustomers] = useState<Customer[]>([])
  const [composeTo, setComposeTo] = useState<{ id: string; name: string } | null>(null)
  async function openPick() {
    setPickOpen(true)
    if (pickCustomers.length === 0) {
      const { data } = await supabase.from('customers').select('*').is('archived_at', null).order('name')
      setPickCustomers((data as Customer[]) || [])
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader title="Scheduled messages"
        description="Written now, sent later — each goes out through the same consent-gated pipeline as every other message."
        action={
          <Button variant="secondary" onClick={openPick}>
            <Plus className="w-4 h-4" /> Schedule a message
          </Button>
        } />

      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="Schedule a message" icon={CalendarClock} size="md">
        <div className="min-h-[16rem] space-y-3">
          <p className="text-xs text-ink-muted">Pick a customer — the composer opens with “Send later” ready.</p>
          <CustomerPicker customers={pickCustomers} value={''} allowManual={false} autoFocus
            onChange={id => {
              const c = pickCustomers.find(x => x.id === id)
              if (c) { setPickOpen(false); setComposeTo({ id: c.id, name: c.name }) }
            }} />
        </div>
      </Modal>
      {composeTo && (
        <SendMessageDialog open onClose={() => { setComposeTo(null); load() }}
          customerId={composeTo.id} customerName={composeTo.name} defaultSendLater />
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {([['upcoming', 'Upcoming'], ['sent', 'Sent'], ['unsent', 'Didn’t send'], ['canceled', 'Canceled']] as [Filter, string][]).map(([k, label]) => (
          <FilterPill key={k} active={filter === k} onClick={() => setFilter(k)}>
            {label}
            {counts[k] > 0 && <span className={cn('text-[10px] font-bold tabular-nums', filter === k ? 'text-black/70' : 'text-ink-faint')}>{counts[k]}</span>}
          </FilterPill>
        ))}
      </div>

      <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
        {loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-3">
                <Skeleton className="h-5 w-24 rounded-full shrink-0" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3 w-28 shrink-0" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={CalendarClock} className="py-16"
            title={filter === 'upcoming' ? 'Nothing scheduled' : filter === 'sent' ? 'No scheduled sends yet' : filter === 'canceled' ? 'Nothing canceled' : 'Nothing failed or skipped'}
            description={filter === 'upcoming'
              ? 'Compose any message and choose “Send later” — it will appear here until it goes out.'
              : 'Scheduled messages that reach this state will show up here.'}
            action={filter === 'upcoming' ? { label: 'Schedule a message', onClick: openPick } : undefined} />
        ) : (
          <div className="divide-y divide-border">
            {rows.map(r => <ScheduledRow key={r.id} r={r} onCancel={cancel} />)}
          </div>
        )}
      </div>
    </div>
  )
}

// pending/canceled aren't provider states, so THE shared vocabulary doesn't carry
// them — everything else renders through statusMeta unchanged.
function scheduledMeta(status: string): StatusMeta {
  if (status === 'pending') return { key: 'pending', label: 'Scheduled', Icon: Clock, tone: 'pending' }
  if (status === 'canceled') return { key: 'canceled', label: 'Canceled', Icon: Ban, tone: 'pending' }
  return statusMeta(status)
}

function ScheduledRow({ r, onCancel }: { r: Row; onCancel: (r: Row) => void }) {
  const meta = scheduledMeta(r.status)
  const label = MSG_LABELS[r.template as MsgType] || r.template
  const when = (() => { try { return format(new Date(r.send_at), 'EEE, MMM d · h:mm a') } catch { return '' } })()
  const channels = r.channels?.length ? r.channels : ['sms', 'email']
  return (
    <div className="px-4 py-3 flex items-center gap-3 hover:bg-surface/40 transition-colors">
      <span className={cn('inline-flex items-center gap-1 text-[10px] rounded-full px-2 py-0.5 border shrink-0', TONE_CLASS[meta.tone])}>
        <meta.Icon className="w-3 h-3 shrink-0" /> {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink truncate">
          <span className="font-semibold">{label}</span>
          {r.customers?.name && (
            <> · <Link href={`/dashboard/customers/${r.customer_id}`} className="text-accent-text hover:underline">{r.customers.name}</Link></>
          )}
        </p>
        <p className="text-[11px] text-ink-faint truncate mt-0.5">
          {r.body ? r.body : 'Personalized from the template when it sends'}
          {r.detail && meta.tone !== 'ok' ? ` — ${r.detail}` : ''}
        </p>
      </div>
      <span className="shrink-0 flex items-center gap-1 text-ink-faint">
        {channels.includes('sms') && <MessageSquare className="w-3.5 h-3.5" aria-label="SMS" />}
        {channels.includes('email') && <Mail className="w-3.5 h-3.5" aria-label="Email" />}
      </span>
      <p className="text-[11px] text-ink-muted tabular-nums shrink-0 hidden sm:block" title={r.status === 'sent' && r.sent_at ? `Sent ${format(new Date(r.sent_at), 'MMM d, h:mm a')}` : undefined}>
        {when}
      </p>
      {r.status === 'pending' && (
        <Button size="sm" variant="ghost" onClick={() => onCancel(r)} title="Cancel this send" aria-label="Cancel this send">
          <X className="w-3.5 h-3.5" /> Cancel
        </Button>
      )}
    </div>
  )
}
