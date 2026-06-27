'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { channel as channelDef } from '@/lib/marketing/channels'
import { listJobs, cancelJob, clearHistory } from '@/lib/marketing/publishQueue'
import { listConnections } from '@/lib/marketing/connections'
import { cn, formatDate } from '@/lib/utils'
import { Loader2, RotateCcw, X, ExternalLink, ListChecks, Trash2 } from 'lucide-react'
import type { PublishJob, PublishJobStatus, SocialConnection } from '@/lib/marketing/types'

const STATUS: Record<PublishJobStatus, { label: string; chip: string }> = {
  draft:      { label: 'Draft',      chip: 'border-border text-ink-muted' },
  scheduled:  { label: 'Scheduled',  chip: 'border-accent/40 text-accent' },
  queued:     { label: 'Queued',     chip: 'border-sky-500/30 text-sky-300' },
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

export function PublishingQueue({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [jobs, setJobs] = useState<PublishJob[]>([])
  const [conns, setConns] = useState<SocialConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [retrying, setRetrying] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [j, c] = await Promise.all([listJobs(supabase, userId, { limit: 60 }), listConnections(supabase, userId)])
    setJobs(j); setConns(c); setLoading(false)
  }, [supabase, userId])
  useEffect(() => { load() }, [load])

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
    } catch { /* ignore */ } finally { setRetrying(null); load() }
  }
  async function cancel(j: PublishJob) {
    const updated = await cancelJob(supabase, j.id)
    if (updated) setJobs(prev => prev.map(x => x.id === j.id ? updated : x))
  }
  async function clear() {
    await clearHistory(supabase, userId)
    setJobs(prev => prev.filter(j => !['published', 'failed', 'canceled'].includes(j.status)))
  }

  const active = jobs.filter(j => ['scheduled', 'queued', 'publishing'].includes(j.status))
  const history = jobs.filter(j => ['published', 'failed', 'canceled'].includes(j.status))

  if (loading) return <div className="h-32 flex items-center justify-center text-ink-faint"><Loader2 className="w-5 h-5 animate-spin" /></div>
  if (!jobs.length) return <InlineEmpty icon={ListChecks}>No publishes yet. Schedule or publish a post and it’ll show up here.</InlineEmpty>

  const Row = ({ j }: { j: PublishJob }) => {
    const def = channelDef(j.platform)
    const meta = STATUS[j.status]
    return (
      <div className="flex items-center gap-2.5 rounded-card border border-border bg-bg-secondary px-3 py-2">
        <def.icon className="w-4 h-4 text-ink-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-ink truncate">{def.label} · {connName(j.connection_id)}</p>
          <p className="text-[10px] text-ink-faint truncate">{whenLabel(j)}{j.error ? ` · ${j.error}` : ''}{j.attempts > 0 ? ` · ${j.attempts} attempt${j.attempts > 1 ? 's' : ''}` : ''}</p>
        </div>
        <span className={cn('text-[10px] font-medium rounded-full border px-1.5 py-0.5 shrink-0', meta.chip)}>{meta.label}</span>
        {j.status === 'failed' && <Button size="sm" variant="ghost" loading={retrying === j.id} onClick={() => retry(j)}><RotateCcw className="w-3.5 h-3.5" /></Button>}
        {(j.status === 'scheduled' || j.status === 'queued') && <button onClick={() => cancel(j)} className="text-ink-faint hover:text-red-400" title="Cancel"><X className="w-4 h-4" /></button>}
        {j.status === 'published' && j.external_url && <a href={j.external_url} target="_blank" rel="noreferrer" className="text-ink-faint hover:text-ink" title="View post"><ExternalLink className="w-3.5 h-3.5" /></a>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {active.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">In progress · {active.length}</p>
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
    </div>
  )
}
