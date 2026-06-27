'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { PublishingHub } from './PublishingHub'
import { channel as channelDef } from '@/lib/marketing/channels'
import { listConnections } from '@/lib/marketing/connections'
import { listJobsForPiece, markManualPublished } from '@/lib/marketing/publishQueue'
import { cn } from '@/lib/utils'
import { Send, CalendarPlus, Settings2, CheckCircle2, Loader2, ExternalLink, Copy } from 'lucide-react'
import type { ContentPiece, MarketingChannel, PublishJob, PublishJobStatus, PublishResponse, SocialConnection } from '@/lib/marketing/types'

const STATUS_LABEL: Record<PublishJobStatus, string> = {
  draft: 'Draft', scheduled: 'Scheduled', queued: 'Queued', publishing: 'Publishing', published: 'Published', failed: 'Failed', canceled: 'Canceled',
}

// The composer's publishing workflow: pick a connected account (or manual), then
// Publish now or Schedule. Reflects the live job status. Manual mode copies the caption
// + opens the platform, then the owner confirms with "Mark as posted".
export function PublishPanel({ piece, ch, userId, beforePublish, onPieceUpdate }: {
  piece: ContentPiece
  ch: MarketingChannel
  userId: string
  beforePublish: () => Promise<void>
  onPieceUpdate?: (p: ContentPiece) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const def = channelDef(ch)
  const [conns, setConns] = useState<SocialConnection[]>([])
  const [jobs, setJobs] = useState<PublishJob[]>([])
  const [selected, setSelected] = useState<string | null>(null) // connection id or null = manual
  const [busy, setBusy] = useState<'now' | 'schedule' | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDate, setScheduleDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [manualPending, setManualPending] = useState<PublishJob | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'info' | 'danger'; text: string } | null>(null)
  const [hub, setHub] = useState(false)

  const channelConns = useMemo(() => conns.filter(c => c.platform === ch), [conns, ch])

  useEffect(() => {
    let active = true
    Promise.all([listConnections(supabase, userId), listJobsForPiece(supabase, userId, piece.id)]).then(([c, j]) => {
      if (!active) return
      setConns(c)
      setJobs(j)
      const forCh = c.filter(x => x.platform === ch)
      setSelected(forCh[0]?.id ?? null)
    })
    return () => { active = false }
  }, [supabase, userId, piece.id, ch])

  const currentJob = useMemo(() => jobs.find(j => (j.connection_id ?? null) === selected) || null, [jobs, selected])

  function applyJob(job: PublishJob) {
    setJobs(prev => { const rest = prev.filter(j => j.id !== job.id); return [job, ...rest] })
  }

  async function send(scheduledFor: string | null) {
    setBusy(scheduledFor ? 'schedule' : 'now'); setMsg(null); setManualPending(null)
    try {
      await beforePublish()
      const res = await fetch('/api/marketing/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pieceId: piece.id, connectionId: selected, scheduledFor }),
      })
      const data = await res.json() as PublishResponse
      if (data.job) applyJob(data.job)
      if (!data.ok && !data.manual) { setMsg({ tone: 'danger', text: data.error || 'Could not publish.' }); return }
      if (data.manual && data.job) {
        // Manual mode: copy + open, then the owner confirms.
        try { await navigator.clipboard?.writeText(data.manual.caption) } catch { /* ignore */ }
        window.open(data.manual.openUrl, '_blank')
        setManualPending(data.job)
        setMsg({ tone: 'info', text: `Caption copied and ${def.label} opened — paste it, then mark it posted.` })
      } else if (scheduledFor) {
        setMsg({ tone: 'success', text: `Scheduled for ${scheduleDate}.` })
        onPieceUpdate?.({ ...piece, status: 'scheduled', scheduled_for: scheduledFor })
      } else if (data.job?.status === 'published') {
        setMsg({ tone: 'success', text: 'Published.' })
        onPieceUpdate?.({ ...piece, status: 'published' })
      }
    } catch {
      setMsg({ tone: 'danger', text: 'Could not reach the publisher.' })
    } finally {
      setBusy(null); setScheduleOpen(false)
    }
  }

  async function confirmManual() {
    if (!manualPending) return
    const updated = await markManualPublished(supabase, manualPending)
    if (updated) { applyJob(updated); setManualPending(null); setMsg({ tone: 'success', text: 'Marked as posted.' }); onPieceUpdate?.({ ...piece, status: 'published' }) }
  }

  return (
    <div className="rounded-card border border-border bg-surface/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint inline-flex items-center gap-1.5"><Send className="w-3.5 h-3.5 text-accent" /> Publish</p>
        <button onClick={() => setHub(true)} className="text-[11px] text-ink-faint hover:text-ink inline-flex items-center gap-1"><Settings2 className="w-3 h-3" /> Accounts</button>
      </div>

      {/* Account selector */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button onClick={() => setSelected(null)} className={cn('rounded-full px-2.5 py-1 text-xs border transition-colors', selected === null ? 'bg-accent text-black border-accent' : 'bg-surface text-ink-muted border-border hover:text-ink')}>Copy &amp; paste</button>
        {channelConns.map(c => (
          <button key={c.id} onClick={() => setSelected(c.id)} className={cn('rounded-full px-2.5 py-1 text-xs border transition-colors inline-flex items-center gap-1', selected === c.id ? 'bg-accent text-black border-accent' : 'bg-surface text-ink-muted border-border hover:text-ink')}>
            <CheckCircle2 className="w-3 h-3" /> {c.account_name}
          </button>
        ))}
      </div>

      {currentJob && (
        <p className="text-[11px] text-ink-faint inline-flex items-center gap-1.5">
          Status: <span className="text-ink-muted">{STATUS_LABEL[currentJob.status]}</span>
          {currentJob.external_url && <a href={currentJob.external_url} target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5">view <ExternalLink className="w-3 h-3" /></a>}
          {currentJob.error && <span className="text-red-400">· {currentJob.error}</span>}
        </p>
      )}

      {manualPending ? (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={confirmManual}><CheckCircle2 className="w-3.5 h-3.5" /> Mark as posted</Button>
          <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard?.writeText(''); window.open(def.openUrl, '_blank') }}><ExternalLink className="w-3.5 h-3.5" /> Open {def.label} again</Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={() => send(null)} loading={busy === 'now'}>
            {selected === null ? <><Copy className="w-3.5 h-3.5" /> Copy &amp; open</> : <><Send className="w-3.5 h-3.5" /> Publish now</>}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setScheduleOpen(o => !o)}><CalendarPlus className="w-3.5 h-3.5" /> Schedule</Button>
          {scheduleOpen && (
            <>
              <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} className="bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-xs text-ink" />
              <Button size="sm" onClick={() => send(`${scheduleDate}T09:00:00.000Z`)} loading={busy === 'schedule'}>Set</Button>
            </>
          )}
        </div>
      )}

      {msg && <Banner tone={msg.tone} onDismiss={() => setMsg(null)}>{msg.text}</Banner>}

      <PublishingHub userId={userId} open={hub} onClose={() => { setHub(false); listConnections(supabase, userId).then(setConns) }} />
    </div>
  )
}
