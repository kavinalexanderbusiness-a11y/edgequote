'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { FilterPill } from '@/components/ui/FilterPill'
import { SearchInput } from '@/components/ui/SearchInput'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { MSG_LABELS, type MsgType } from '@/lib/comms/templates'
import { statusMeta, TONE_CLASS } from '@/lib/comms/logStatus'
import { describeSkip } from '@/lib/comms/skipReasons'
import { cn } from '@/lib/utils'
import { format } from 'date-fns'
import { History, Mail, MessageSquare, Bot, Megaphone, Loader2, User } from 'lucide-react'

// ── Message history: the business-wide send ledger ─────────────────────────────
// A READ-ONLY view over notification_log — the audit trail every sender already
// writes through lib/comms/log (manual sends, reminders, quote follow-ups,
// invoice reminders, review requests, campaigns, receipts). Nothing here sends,
// retries or duplicates; the badges/skip reasons reuse THE shared vocabulary
// (lib/comms/logStatus + skipReasons), so this page and each customer's thread
// can never disagree about what happened.

interface Row {
  id: string; created_at: string; channel: string; template: string
  status: string; detail: string | null; customer_id: string | null
  customers?: { name: string } | null
}

// Display grouping (send-time + delivery-time states from THE status vocabulary).
type StatusFilter = 'all' | 'sent' | 'skipped' | 'failed'
const STATUS_SETS: Record<Exclude<StatusFilter, 'all'>, string[]> = {
  sent: ['sent', 'delivered', 'opened', 'clicked', 'reply'],
  skipped: ['skipped', 'disabled', 'unsubscribed'],
  failed: ['error', 'failed', 'bounced', 'spam'],
}
type ChannelFilter = 'all' | 'sms' | 'email'
const PAGE = 50

export default function MessageHistoryPage() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [template, setTemplate] = useState<string>('all')
  const [query, setQuery] = useState('')
  const seq = useRef(0)

  async function load(reset: boolean) {
    const mySeq = ++seq.current
    if (reset) setLoading(true); else setLoadingMore(true)
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { if (mySeq === seq.current) setLoading(false); return }
    const from = reset ? 0 : rows.length
    const q = query.trim()
    // Name search needs an INNER join (a filter on an embedded table silently
    // matches nothing on a LEFT join); without a search the LEFT join keeps rows
    // whose customer was deleted (customer_id is null) honest and visible.
    let qb = supabase.from('notification_log')
      .select(q ? 'id, created_at, channel, template, status, detail, customer_id, customers!inner(name)' : 'id, created_at, channel, template, status, detail, customer_id, customers(name)')
      .eq('user_id', uid)
    if (q) qb = qb.ilike('customers.name', `%${q}%`)
    if (status !== 'all') qb = qb.in('status', STATUS_SETS[status])
    if (channel !== 'all') qb = qb.eq('channel', channel)
    if (template !== 'all') qb = qb.eq('template', template)
    const { data } = await qb.order('created_at', { ascending: false }).range(from, from + PAGE - 1)
    if (mySeq !== seq.current) return
    const got = (data as unknown as Row[]) || []
    setRows(prev => reset ? got : [...prev, ...got.filter(r => !prev.some(p => p.id === r.id))])
    setHasMore(got.length === PAGE)
    setLoading(false); setLoadingMore(false)
  }

  // Filters reload immediately; the search debounces.
  useEffect(() => { load(true) }, [status, channel, template]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => load(true), 250)
    return () => clearTimeout(t)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  // Every template the app can send, offered as a dropdown — the list comes from
  // THE template registry so a new MsgType shows up here automatically.
  const templateOptions = useMemo(
    () => (Object.entries(MSG_LABELS) as [MsgType, string][]).sort((a, b) => a[1].localeCompare(b[1])),
    [],
  )

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader title="Message history"
        description="Every templated and automated send — reminders, follow-ups, review requests, receipts, campaigns — across all customers."
        action={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/grow/crm"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink border border-border rounded-xl px-3 py-2 transition-colors">
              <Megaphone className="w-3.5 h-3.5" /> Campaigns
            </Link>
            <Link href="/dashboard/automation"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink border border-border rounded-xl px-3 py-2 transition-colors">
              <Bot className="w-3.5 h-3.5" /> Automations
            </Link>
          </div>
        } />

      <SearchInput fieldSize="sm" value={query} onChange={e => setQuery(e.target.value)}
        placeholder="Search by customer name…" aria-label="Search history by customer" />

      <div className="flex items-center gap-1.5 flex-wrap">
        {([['all', 'All'], ['sent', 'Sent'], ['skipped', 'Skipped'], ['failed', 'Failed']] as [StatusFilter, string][]).map(([k, label]) => (
          <FilterPill key={k} active={status === k} onClick={() => setStatus(k)}>{label}</FilterPill>
        ))}
        <span className="w-px h-4 bg-border mx-1" aria-hidden />
        {([['all', 'All channels'], ['sms', 'SMS'], ['email', 'Email']] as [ChannelFilter, string][]).map(([k, label]) => (
          <FilterPill key={k} active={channel === k} onClick={() => setChannel(k)}>
            {k === 'sms' && <MessageSquare className="w-3 h-3" />}{k === 'email' && <Mail className="w-3 h-3" />}{label}
          </FilterPill>
        ))}
        <select value={template} onChange={e => setTemplate(e.target.value)} aria-label="Filter by message type"
          className="ml-auto bg-bg-tertiary border border-border-strong rounded-lg px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent">
          <option value="all">All message types</option>
          {templateOptions.map(([slug, label]) => <option key={slug} value={slug}>{label}</option>)}
        </select>
      </div>

      <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
        {loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="px-4 py-3 flex items-center gap-3">
                <Skeleton className="h-5 w-20 rounded-full shrink-0" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3 w-24 shrink-0" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={History} className="py-16" title="No sends match"
            description={query || status !== 'all' || channel !== 'all' || template !== 'all'
              ? 'Try clearing a filter — this ledger only shows sends that match all of them.'
              : 'Templated and automated sends land here the moment they go out (or are skipped).'} />
        ) : (
          <div className="divide-y divide-border">
            {rows.map(r => <HistoryRow key={r.id} r={r} />)}
          </div>
        )}
      </div>

      {hasMore && !loading && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => load(false)} loading={loadingMore}>
            {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}

function HistoryRow({ r }: { r: Row }) {
  const meta = statusMeta(r.status)
  const label = MSG_LABELS[r.template as MsgType] || r.template
  // The truthful reason, via THE shared resolver — never a hardcoded "no opt-in".
  const reason = r.status === 'disabled' ? 'messaging not set up'
    : r.status === 'skipped' ? describeSkip(r.detail).label
    : (meta.tone === 'fail' && r.detail) ? r.detail
    : null
  const Ch = r.channel === 'email' ? Mail : MessageSquare
  const time = (() => { try { return format(new Date(r.created_at), 'MMM d, h:mm a') } catch { return '' } })()
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
          {!r.customers?.name && r.customer_id === null && <span className="text-ink-faint"> · customer removed</span>}
        </p>
        {reason && <p className="text-[11px] text-ink-faint truncate mt-0.5">{reason}</p>}
      </div>
      <span title={r.channel === 'email' ? 'Email' : 'SMS'} className="shrink-0 flex text-ink-faint">
        <Ch className="w-3.5 h-3.5" aria-label={r.channel} />
      </span>
      <p className="text-[11px] text-ink-faint tabular-nums shrink-0 hidden sm:block">{time}</p>
      {r.customer_id && (
        <Link href={`/dashboard/customers/${r.customer_id}`} title="Customer profile" aria-label="Customer profile"
          className="shrink-0 h-7 w-7 rounded-lg text-ink-faint hover:text-ink hover:bg-black/10 flex items-center justify-center">
          <User className="w-3.5 h-3.5" />
        </Link>
      )}
    </div>
  )
}
