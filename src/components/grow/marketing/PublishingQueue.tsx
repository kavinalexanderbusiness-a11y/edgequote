'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { channel as channelDef } from '@/lib/marketing/channels'
import { listJobs, cancelJob, retryJob, clearHistory, markManualPublished, captionFor } from '@/lib/marketing/publishQueue'
import { listConnections } from '@/lib/marketing/connections'
import { toast } from '@/lib/toast'
import { cn, formatDate } from '@/lib/utils'
import { Loader2, RotateCcw, X, ExternalLink, ListChecks, Trash2, Copy, CheckCircle2, Search, Play } from 'lucide-react'
import type { MarketingChannel, PublishJob, PublishJobStatus, SocialConnection } from '@/lib/marketing/types'

const STATUS: Record<PublishJobStatus, { label: string; chip: string }> = {
  draft:      { label: 'Draft',      chip: 'border-border text-ink-muted' },
  scheduled:  { label: 'Scheduled',  chip: 'border-accent/40 text-accent' },
  queued:     { label: 'Ready to post', chip: 'border-sky-500/30 text-sky-300' },
  publishing: { label: 'Publishing', chip: 'border-amber-500/30 text-amber-300' },
  published:  { label: 'Published',  chip: 'border-emerald-500/30 text-emerald-300' },
  failed:     { label: 'Failed',     chip: 'border-red-500/30 text-red-300' },
  canceled:   { label: 'Canceled',   chip: 'border-border text-ink-faint' },
}

function whenLabel(j: PublishJob): string {
  if (j.status === 'published' && j.published_at) return `Posted ${formatDate(j.published_at)}`
  if (j.scheduled_for) return `Scheduled ${formatDate(j.scheduled_for)}`
  return formatDate(j.created_at)
}

interface PieceInfo { caption: string; hashtags: string[] }

export function PublishingQueue({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [jobs, setJobs] = useState<PublishJob[]>([])
  const [conns, setConns] = useState<SocialConnection[]>([])
  const [pieceByJob, setPieceByJob] = useState<Record<string, PieceInfo>>({})
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [publishingAll, setPublishingAll] = useState(false)
  // Search + filters over the full history.
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'published' | 'failed'>('all')
  const [platformFilter, setPlatformFilter] = useState<'all' | MarketingChannel>('all')

  // Fetch + render jobs immediately (no blocking server round-trip first).
  const fetchJobs = useCallback(async () => {
    const [j, c] = await Promise.all([listJobs(supabase, userId, { limit: 100 }), listConnections(supabase, userId)])
    setJobs(j); setConns(c)
    // Caption + hashtags for every job's post — the rich history + copy-to-post.
    const pieceIds = Array.from(new Set(j.map(x => x.content_piece_id)))
    if (pieceIds.length) {
      const { data } = await supabase.from('content_pieces').select('id, body, hashtags').in('id', pieceIds)
      const m: Record<string, PieceInfo> = {}
      for (const p of (data as { id: string; body: string; hashtags: string[] }[] | null) || []) m[p.id] = { caption: captionFor(p), hashtags: p.hashtags || [] }
      setPieceByJob(m)
    }
  }, [supabase, userId])
  useEffect(() => { fetchJobs().finally(() => setLoading(false)) }, [fetchJobs])
  // Process this owner's due jobs in the BACKGROUND (no cron needed), then refresh
  // in place — the queue paints first instead of waiting behind the round-trip.
  useEffect(() => { fetch('/api/marketing/publish/process', { method: 'POST' }).then(() => fetchJobs()).catch(() => {}) }, [fetchJobs])

  const connName = useMemo(() => {
    const m = new Map(conns.map(c => [c.id, c.account_name]))
    return (id: string | null) => (id ? m.get(id) || 'Connected account' : 'Manual (copy & paste)')
  }, [conns])

  async function retry(j: PublishJob) {
    setRetrying(j.id)
    try {
      const res = await fetch('/api/marketing/publish/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: j.id }) })
      const data = await res.json()
      if (data?.job) setJobs(prev => prev.map(x => x.id === j.id ? data.job : x))
    } catch { /* ignore */ } finally { setRetrying(null); fetchJobs() }
  }
  async function cancel(j: PublishJob) {
    const updated = await cancelJob(supabase, j.id)
    if (updated) setJobs(prev => prev.map(x => x.id === j.id ? updated : x))
    toast.undo('Post canceled.', async () => {
      const back = await retryJob(supabase, j.id) // → back to 'ready to post'
      if (back) setJobs(prev => prev.map(x => x.id === j.id ? back : x))
    })
  }
  function copyCaption(j: PublishJob) {
    const cap = pieceByJob[j.content_piece_id]?.caption
    if (cap) { try { navigator.clipboard?.writeText(cap); toast.success('Caption copied.') } catch { /* still visible to copy by hand */ } }
  }
  async function markPosted(j: PublishJob) {
    const updated = await markManualPublished(supabase, j)
    if (updated) setJobs(prev => prev.map(x => x.id === j.id ? updated : x))
  }
  // Drive the whole queue forward (API posts publish; manual scheduled → ready). The
  // server loop is per-job try/continue, so one failure never stops the rest.
  async function publishAll() {
    setPublishingAll(true)
    try { await fetch('/api/marketing/publish/process', { method: 'POST' }) } catch { /* ignore */ }
    await fetchJobs()
    setPublishingAll(false)
  }
  // Clear history the app way: hide now, offer Undo, and only commit the delete once
  // the undo window passes — so one stray click can never wipe the whole history.
  function clear() {
    const snapshot = jobs
    const clearedCount = jobs.filter(j => ['published', 'failed', 'canceled'].includes(j.status)).length
    if (!clearedCount) return
    setJobs(prev => prev.filter(j => !['published', 'failed', 'canceled'].includes(j.status)))
    let undone = false
    toast.undo(`Cleared ${clearedCount} item${clearedCount !== 1 ? 's' : ''} from history.`, () => { undone = true; setJobs(snapshot) })
    if (typeof window !== 'undefined') window.setTimeout(() => { if (!undone) clearHistory(supabase, userId) }, 7000)
  }

  // Search + filter across everything, then split into the two sections.
  const q = query.trim().toLowerCase()
  const filtered = jobs.filter(j => {
    if (platformFilter !== 'all' && j.platform !== platformFilter) return false
    if (statusFilter === 'active' && !['scheduled', 'queued', 'publishing'].includes(j.status)) return false
    if (statusFilter === 'published' && j.status !== 'published') return false
    if (statusFilter === 'failed' && j.status !== 'failed') return false
    if (q) {
      const hay = `${channelDef(j.platform).label} ${connName(j.connection_id)} ${pieceByJob[j.content_piece_id]?.caption ?? ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
  const active = filtered.filter(j => ['scheduled', 'queued', 'publishing'].includes(j.status))
  const history = filtered.filter(j => ['published', 'failed', 'canceled'].includes(j.status))
  // Only count what "Process" can actually advance: any scheduled job comes due, and
  // API-mode queued jobs publish. A manual queued post waits on the owner to paste it,
  // so counting it here would make the button look like it did nothing.
  const readyCount = jobs.filter(j => j.status === 'scheduled' || (j.status === 'queued' && j.mode === 'api')).length

  if (loading) return <div className="h-32 flex items-center justify-center text-ink-faint"><Loader2 className="w-5 h-5 animate-spin" /></div>
  if (!jobs.length) return <InlineEmpty icon={ListChecks}>No publishes yet. Schedule or publish a post and it’ll show up here.</InlineEmpty>

  const Row = ({ j }: { j: PublishJob }) => {
    const def = channelDef(j.platform)
    const meta = STATUS[j.status]
    const piece = pieceByJob[j.content_piece_id]
    return (
      <div className="rounded-card border border-border bg-bg-secondary px-3 py-2.5 space-y-1.5">
        <div className="flex items-center gap-2.5">
          <def.icon className="w-4 h-4 text-ink-muted shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-ink truncate">
              {def.label} · {connName(j.connection_id)}
              <span className="ml-1.5 text-[9px] uppercase tracking-wide text-ink-faint border border-border rounded px-1 py-0.5">{j.mode === 'api' ? 'API' : 'Manual'}</span>
            </p>
            <p className="text-[10px] text-ink-faint truncate">{whenLabel(j)}{j.attempts > 0 ? ` · ${j.attempts} attempt${j.attempts > 1 ? 's' : ''}` : ''}</p>
          </div>
          <span className={cn('text-[10px] font-medium rounded-full border px-1.5 py-0.5 shrink-0', meta.chip)}>{meta.label}</span>
        </div>

        {/* Caption + hashtags — the rich history detail */}
        {piece?.caption && <p className="text-[11px] text-ink-muted line-clamp-2 pl-6">{piece.caption}</p>}
        {piece?.hashtags?.length ? <p className="text-[10px] text-accent/80 truncate pl-6">{piece.hashtags.slice(0, 6).map(h => `#${h.replace(/^#/, '')}`).join(' ')}</p> : null}
        {j.error && <p className="text-[10px] text-red-400 pl-6">{j.error}</p>}

        {/* Actions */}
        <div className="flex items-center gap-1.5 pl-6">
          {j.mode === 'manual' && j.status === 'queued' && (
            <>
              <button onClick={() => copyCaption(j)} className="text-ink-faint hover:text-ink inline-flex items-center gap-1 text-[11px]" title="Copy caption"><Copy className="w-3.5 h-3.5" /> Copy caption</button>
              <a href={def.openUrl} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink inline-flex items-center gap-1 text-[11px]" title={`Open ${def.label}`}><ExternalLink className="w-3.5 h-3.5" /> Open</a>
              <Button size="sm" variant="ghost" onClick={() => markPosted(j)}><CheckCircle2 className="w-3.5 h-3.5" /> Mark as posted</Button>
            </>
          )}
          {j.status === 'failed' && <Button size="sm" variant="ghost" loading={retrying === j.id} onClick={() => retry(j)}><RotateCcw className="w-3.5 h-3.5" /> Retry</Button>}
          {(j.status === 'scheduled' || j.status === 'queued') && <button onClick={() => cancel(j)} className="text-ink-faint hover:text-red-400 inline-flex items-center gap-1 text-[11px]" title="Cancel"><X className="w-3.5 h-3.5" /> Cancel</button>}
          {j.status === 'published' && j.external_url && <a href={j.external_url} target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-1 text-[11px]" title="View post"><ExternalLink className="w-3.5 h-3.5" /> View post</a>}
        </div>
      </div>
    )
  }

  const platformsPresent = Array.from(new Set(jobs.map(j => j.platform)))

  return (
    <div className="space-y-3">
      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[140px]">
          <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search caption or platform…"
            className="w-full bg-bg-tertiary border border-border rounded-lg pl-8 pr-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
          className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent">
          <option value="all">All statuses</option>
          <option value="active">Scheduled &amp; ready</option>
          <option value="published">Published</option>
          <option value="failed">Failed</option>
        </select>
        <select value={platformFilter} onChange={e => setPlatformFilter(e.target.value as typeof platformFilter)}
          className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent">
          <option value="all">All platforms</option>
          {platformsPresent.map(p => <option key={p} value={p}>{channelDef(p).label}</option>)}
        </select>
        {readyCount > 0 && (
          <Button size="sm" variant="secondary" loading={publishingAll} onClick={publishAll} title="Process all scheduled & ready posts">
            <Play className="w-3.5 h-3.5" /> Process ready ({readyCount})
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <InlineEmpty icon={Search}>No posts match those filters.</InlineEmpty>
      ) : (
        <>
          {active.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Scheduled &amp; ready · {active.length}</p>
              {active.map(j => <Row key={j.id} j={j} />)}
            </div>
          )}
          {history.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">History · {history.length}</p>
                <button onClick={clear} className="text-[11px] text-ink-faint hover:text-red-400 inline-flex items-center gap-1"><Trash2 className="w-3 h-3" /> Clear</button>
              </div>
              {history.map(j => <Row key={j.id} j={j} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
