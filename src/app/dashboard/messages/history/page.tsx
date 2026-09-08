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
import { History, Mail, MessageSquare, Bot, Megaphone, Loader2, User, Reply, Timer, CalendarClock, CheckCheck, Send } from 'lucide-react'

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

// From THE insights engine (comms_insights RPC) — any future surface reuses the
// same function, so two pages can never disagree about the numbers.
interface Insights {
  sends: number; delivered: number; failed: number; skipped: number
  inbound: number; needs_reply: number; scheduled_pending: number
  median_reply_minutes: number | null
}

const fmtReply = (m: number | null) =>
  m == null ? '—' : m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`

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
  const [insights, setInsights] = useState<(Insights & { ownerId: string }) | null>(null)
  const [loadedFilter, setLoadedFilter] = useState<string | null>(null)
  const [loadedOwner, setLoadedOwner] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<{ filter: string; reset: boolean } | null>(null)
  const seq = useRef(0)
  const previousQuery = useRef(query)
  const filterKey = JSON.stringify([status, channel, template, query.trim()])
  const visibleRows = loadedFilter === filterKey ? rows : []
  const error = loadError?.filter === filterKey ? loadError : null

  // The strip loads once per verified owner, not once per page of results.
  useEffect(() => {
    if (!loadedOwner) return
    let active = true
    Promise.resolve(supabase.rpc('comms_insights', { p_days: 30 })).then(({ data, error }) => {
      if (active && !error && data) setInsights({ ...(data as Insights), ownerId: loadedOwner })
    }).catch(() => {})
    return () => { active = false }
  }, [supabase, loadedOwner])

  async function load(reset: boolean) {
    if (!reset && (loadedFilter !== filterKey || loading || loadingMore)) return
    const mySeq = ++seq.current
    let replace = reset
    let verifiedOwner = false
    setLoadError(null)
    if (reset) setLoading(true); else setLoadingMore(true)
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (mySeq !== seq.current) return
      const uid = session?.user?.id
      if (sessionError || !uid) throw new Error('History session unavailable')
      verifiedOwner = true
      if (loadedOwner !== uid) {
        // A pagination/retry click can outlive its login. Never append a new
        // owner's page to the previous owner's rows, or retain them on failure.
        replace = true
        setRows([]); setLoadedFilter(null); setLoadedOwner(uid); setHasMore(false); setInsights(null)
        setLoading(true); setLoadingMore(false)
      }
      const from = replace ? 0 : rows.length
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
      const { data, error: readError } = await qb.order('created_at', { ascending: false }).range(from, from + PAGE - 1)
      if (mySeq !== seq.current) return
      if (readError || !Array.isArray(data)) throw new Error('History read unavailable')
      const got = data as unknown as Row[]
      setRows(prev => replace ? got : [...prev, ...got.filter(r => !prev.some(p => p.id === r.id))])
      setLoadedFilter(filterKey)
      setHasMore(got.length === PAGE)
    } catch {
      if (mySeq === seq.current) {
        if (!verifiedOwner) {
          setRows([]); setLoadedFilter(null); setLoadedOwner(null); setHasMore(false); setInsights(null)
          replace = true
        }
        setLoadError({ filter: filterKey, reset: replace })
      }
    } finally {
      if (mySeq === seq.current) { setLoading(false); setLoadingMore(false) }
    }
  }

  // Invalidate old responses during the debounce too, not just when the next
  // request starts. Known rows remain available only for their exact filters.
  function invalidateRequests() { seq.current++ }
  useEffect(() => {
    const debounce = query !== previousQuery.current
    previousQuery.current = query
    setLoadError(null)
    setLoading(true)
    let t: ReturnType<typeof setTimeout> | undefined
    if (debounce) t = setTimeout(() => load(true), 250)
    else void load(true)
    return () => { clearTimeout(t); invalidateRequests() }
  }, [status, channel, template, query]) // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* 30-day pulse. Median reply time is THE number that wins work — leads that
          hear back fast book; this makes the habit visible. Tiles link to the
          surface where the number can be acted on. */}
      {insights && insights.ownerId === loadedOwner && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <InsightTile icon={Send} label="Sent · 30d" value={String(insights.sends)} />
          <InsightTile icon={CheckCheck} label="Delivered" tone={insights.failed > 0 ? 'text-amber-400' : undefined}
            value={insights.sends ? `${Math.round((insights.delivered / insights.sends) * 100)}%` : '—'}
            sub={insights.failed > 0 ? `${insights.failed} failed` : undefined} />
          <InsightTile icon={Timer} label="Median reply" value={fmtReply(insights.median_reply_minutes)}
            sub={insights.inbound ? `${insights.inbound} inbound` : undefined} />
          <InsightTile icon={Reply} label="Awaiting reply" href="/dashboard/messages?f=needs_reply"
            value={String(insights.needs_reply)} tone={insights.needs_reply > 0 ? 'text-amber-400' : undefined} />
          <InsightTile icon={CalendarClock} label="Scheduled" href="/dashboard/messages/scheduled"
            value={String(insights.scheduled_pending)} />
        </div>
      )}

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

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/25 bg-bg-secondary p-4 space-y-2">
          <p className="text-sm text-ink">{error.reset ? 'Could not load message history.' : 'Could not load more message history.'}</p>
          {visibleRows.length > 0 && <p className="text-xs text-ink-muted">Showing previously loaded messages. This list may be incomplete.</p>}
          <Button variant="secondary" size="sm" onClick={() => load(error.reset)}>Retry reading history</Button>
        </div>
      )}

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
        ) : error && visibleRows.length === 0 ? null : visibleRows.length === 0 ? (
          <EmptyState icon={History} className="py-16" title="No sends match"
            description={query || status !== 'all' || channel !== 'all' || template !== 'all'
              ? 'Try clearing a filter — this ledger only shows sends that match all of them.'
              : 'Templated and automated sends land here the moment they go out (or are skipped).'} />
        ) : (
          <div className="divide-y divide-border">
            {visibleRows.map(r => <HistoryRow key={r.id} r={r} />)}
          </div>
        )}
      </div>

      {hasMore && loadedFilter === filterKey && !loading && !error && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={() => load(false)} loading={loadingMore}>
            {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}

function InsightTile({ icon: Icon, label, value, sub, tone, href }: {
  icon: typeof Send; label: string; value: string; sub?: string; tone?: string; href?: string
}) {
  const body = (
    <>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint flex items-center gap-1"><Icon className="w-3 h-3" /> {label}</p>
      <p className={cn('text-lg font-bold tabular-nums mt-0.5', tone || 'text-ink')}>{value}</p>
      {sub && <p className="text-[10px] text-ink-faint">{sub}</p>}
    </>
  )
  const cls = 'rounded-xl border border-border bg-bg-secondary px-3 py-2 min-w-0'
  return href
    ? <Link href={href} className={cn(cls, 'block hover:border-border-strong transition-colors')}>{body}</Link>
    : <div className={cls}>{body}</div>
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
    <div className="px-4 py-3 flex items-center gap-3 hover:bg-surface-raised/40 transition-colors">
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
