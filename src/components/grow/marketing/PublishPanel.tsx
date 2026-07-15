'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { PublishingHub } from './PublishingHub'
import { channel as channelDef } from '@/lib/marketing/channels'
import { listConnections } from '@/lib/marketing/connections'
import { listJobsForPiece, markManualPublished, captionFor } from '@/lib/marketing/publishQueue'
import { effectiveMode } from '@/lib/marketing/providers'
import { FilterPill } from '@/components/ui/FilterPill'
import { Send, CalendarPlus, Settings2, CheckCircle2, ExternalLink, Copy, Download } from 'lucide-react'
import type { ContentPiece, MarketingChannel, PublishJob, PublishJobStatus, PublishResponse, SocialConnection } from '@/lib/marketing/types'

const STATUS_LABEL: Record<PublishJobStatus, string> = {
  draft: 'Draft', scheduled: 'Scheduled', queued: 'Ready to post', publishing: 'Publishing', published: 'Published', failed: 'Failed', canceled: 'Canceled',
}

// The composer's publishing workflow: pick a connected account (or copy & paste),
// then Publish now or Schedule. Manual is the live path for every platform today
// (no provider auto-posts yet), so manual must be ROCK-SOLID:
//   • the clipboard copy + opening the platform happen INSIDE the click gesture
//     (never after an await) so the browser can't silently block them;
//   • a manual post that's queued (incl. a scheduled one that came due) is always
//     completable — Copy / Open / Mark as posted — even after a reload.
export function PublishPanel({ piece, ch, userId, hasPhoto, onSavePhoto, beforePublish, onPieceUpdate }: {
  piece: ContentPiece
  ch: MarketingChannel
  userId: string
  hasPhoto?: boolean
  onSavePhoto?: () => void
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

  const selectedConn = useMemo(() => channelConns.find(c => c.id === selected) || null, [channelConns, selected])
  const currentJob = useMemo(() => jobs.find(j => (j.connection_id ?? null) === selected) || null, [jobs, selected])
  // Manual is the path unless a live API provider backs the chosen account.
  const willManual = effectiveMode(ch, selectedConn?.mode) === 'manual'
  // A manual post is "ready to post" once it's queued (publish-now or a scheduled
  // one that came due). This is what makes scheduled posts completable + resumable.
  const manualReady = willManual && !!currentJob && currentJob.status === 'queued'
  const published = currentJob?.status === 'published'

  function applyJob(job: PublishJob) {
    setJobs(prev => { const rest = prev.filter(j => j.id !== job.id); return [job, ...rest] })
  }

  // Gesture-safe manual actions — called DIRECTLY from a click, never after await.
  function copyCaption() {
    try { navigator.clipboard?.writeText(captionFor(piece)) } catch { /* clipboard blocked — the caption is still on screen to copy by hand */ }
  }
  function openPlatform() { window.open(def.openUrl, '_blank') }

  // Record the publish/schedule on the server (idempotent). For manual this just
  // moves the job to "ready to post"; the copy/open already happened in-gesture.
  async function record(scheduledFor: string | null) {
    setBusy(scheduledFor ? 'schedule' : 'now'); setMsg(null)
    try {
      await beforePublish()
      const res = await fetch('/api/marketing/publish', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pieceId: piece.id, connectionId: selected, scheduledFor }),
      })
      const data = await res.json() as PublishResponse
      if (data.job) applyJob(data.job)
      if (!data.ok && !data.manual) { setMsg({ tone: 'danger', text: data.error || 'Could not publish.' }); return }
      if (scheduledFor) {
        setMsg({ tone: 'success', text: willManual ? `Scheduled — ready to post on ${scheduleDate}.` : `Scheduled for ${scheduleDate}.` })
        onPieceUpdate?.({ ...piece, status: 'scheduled', scheduled_for: scheduledFor })
      } else if (data.manual) {
        setMsg({ tone: 'info', text: `Caption copied — paste it in ${def.label}, then tap “Mark as posted”.` })
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

  // Publish now. For manual we copy + save the photo + open the platform
  // synchronously (in-gesture), THEN record — so the clipboard, the download and
  // the new tab are never blocked. Saving the photo matters: photo-mandatory
  // platforms (Instagram) can't be posted from a caption alone.
  function publishNow() {
    if (willManual) { openPlatform(); copyCaption(); if (hasPhoto && onSavePhoto) onSavePhoto() }
    void record(null)
  }

  async function confirmManual() {
    if (!currentJob) return
    const updated = await markManualPublished(supabase, currentJob)
    if (updated) { applyJob(updated); setMsg({ tone: 'success', text: 'Marked as posted.' }); onPieceUpdate?.({ ...piece, status: 'published' }) }
  }

  return (
    <div className="rounded-card border border-border bg-surface/60 p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint inline-flex items-center gap-1.5"><Send className="w-3.5 h-3.5 text-accent" /> Publish</p>
        <button onClick={() => setHub(true)} className="text-[11px] text-ink-faint hover:text-ink inline-flex items-center gap-1"><Settings2 className="w-3 h-3" /> Manage accounts</button>
      </div>

      {/* Account selector — only when there's an actual choice to make. With no
          connected account, manual is the only mode, so a lone pill is just noise. */}
      {channelConns.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterPill active={selected === null} onClick={() => setSelected(null)}>Copy &amp; paste</FilterPill>
          {channelConns.map(c => (
            <FilterPill key={c.id} active={selected === c.id} onClick={() => setSelected(c.id)}>
              <CheckCircle2 className="w-3 h-3" /> {c.account_name}
            </FilterPill>
          ))}
        </div>
      )}

      {currentJob && (
        <p className="text-[11px] text-ink-faint inline-flex items-center gap-1.5 flex-wrap">
          Status: <span className="text-ink-muted">{STATUS_LABEL[currentJob.status]}</span>
          {currentJob.external_url && <a href={currentJob.external_url} target="_blank" rel="noreferrer" className="text-accent inline-flex items-center gap-0.5">view <ExternalLink className="w-3 h-3" /></a>}
          {currentJob.error && <span className="text-red-400">· {currentJob.error}</span>}
        </p>
      )}

      {published ? (
        <p className="text-xs text-emerald-400 inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Posted.</p>
      ) : manualReady ? (
        // A queued manual post (incl. a scheduled one that came due) — always completable.
        <div className="space-y-2">
          <p className="text-[11px] text-ink-muted">Ready to post. Copy the caption{hasPhoto ? ', save the photo' : ''}, open {def.label}, paste &amp; post, then mark it done.</p>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="secondary" onClick={() => { copyCaption(); setMsg({ tone: 'success', text: 'Caption copied.' }) }}><Copy className="w-3.5 h-3.5" /> Copy caption</Button>
            {hasPhoto && onSavePhoto && <Button size="sm" variant="ghost" onClick={onSavePhoto}><Download className="w-3.5 h-3.5" /> Save photo</Button>}
            <Button size="sm" variant="secondary" onClick={openPlatform}><ExternalLink className="w-3.5 h-3.5" /> Open {def.label}</Button>
            <Button size="sm" onClick={confirmManual}><CheckCircle2 className="w-3.5 h-3.5" /> Mark as posted</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={publishNow} loading={busy === 'now'}>
            {willManual ? <><Copy className="w-3.5 h-3.5" /> Copy &amp; open {def.label}</> : <><Send className="w-3.5 h-3.5" /> Publish now</>}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setScheduleOpen(o => !o)}><CalendarPlus className="w-3.5 h-3.5" /> Schedule</Button>
          {scheduleOpen && (
            <>
              <input type="date" value={scheduleDate} onChange={e => setScheduleDate(e.target.value)} aria-label="Schedule date" className="bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-xs text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              {/* 9am in the owner's LOCAL timezone (a bare Z would land at 1–4am here). */}
              <Button size="sm" variant="secondary" onClick={() => record(new Date(`${scheduleDate}T09:00:00`).toISOString())} loading={busy === 'schedule'}>Set date</Button>
            </>
          )}
          {hasPhoto && onSavePhoto && (
            <Button size="sm" variant="ghost" onClick={onSavePhoto}><Download className="w-3.5 h-3.5" /> Save photo</Button>
          )}
        </div>
      )}

      {msg && <Banner tone={msg.tone} onDismiss={() => setMsg(null)}>{msg.text}</Banner>}

      <PublishingHub userId={userId} open={hub} onClose={() => { setHub(false); listConnections(supabase, userId).then(setConns) }} />
    </div>
  )
}
