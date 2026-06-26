'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { ChannelPreview } from './ChannelPreview'
import { channel as channelDef } from '@/lib/marketing/channels'
import { cn } from '@/lib/utils'
import { Sparkles, RefreshCw, Copy, Check, Download, ExternalLink, ImageOff, Lock, CheckCircle2, Loader2 } from 'lucide-react'
import type { ContentPiece, MarketingCandidate, MarketingChannel } from '@/lib/marketing/types'

function parseHashtags(text: string): string[] {
  return Array.from(new Set(
    text.split(/[\s,]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean),
  )).slice(0, 8)
}

// Force a real file download even cross-origin (the public bucket allows GET).
async function downloadImage(url: string, filename: string) {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const obj = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = obj; a.download = filename
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(obj)
  } catch {
    window.open(url, '_blank') // fall back to opening it
  }
}

export function ContentComposer({ candidate, ch, draft, aiEnabled, businessName, logoUrl, onDraftChange, onGrantConsent }: {
  candidate: MarketingCandidate
  ch: MarketingChannel
  draft: ContentPiece | null
  aiEnabled: boolean
  businessName: string
  logoUrl: string | null
  onDraftChange?: (piece: ContentPiece) => void
  onGrantConsent?: () => void
}) {
  const def = channelDef(ch)
  const supabase = useMemo(() => createClient(), [])

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [hashtagsText, setHashtagsText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [posted, setPosted] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  // Reset the editable fields whenever a different draft is shown (new generation).
  useEffect(() => {
    setTitle(draft?.title || '')
    setBody(draft?.body || '')
    setHashtagsText((draft?.hashtags || []).join(' '))
    setPosted(draft?.status === 'published')
    setSaved(false)
  }, [draft?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const hashtags = useMemo(() => parseHashtags(hashtagsText), [hashtagsText])
  const imageUrl = candidate.bestAfterUrl || candidate.bestBeforeUrl
  const canUsePhoto = !!imageUrl && candidate.photoConsent

  function applyPiece(piece: ContentPiece) {
    setTitle(piece.title || '')
    setBody(piece.body || '')
    setHashtagsText((piece.hashtags || []).join(' '))
    setPosted(piece.status === 'published')
  }

  // Non-streaming fallback (used if streaming is unavailable or fails before any text).
  async function fallbackGenerate(): Promise<boolean> {
    try {
      const res = await fetch('/api/marketing/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: candidate.jobId, channel: ch }),
      })
      const j = await res.json()
      if (j?.ok && j.piece) { applyPiece(j.piece); onDraftChange?.(j.piece); return true }
      if (j?.error) setGenError(j.error)
      return false
    } catch { return false }
  }

  // Stream the post in live (the "watch it write" path).
  async function runGenerate() {
    setGenError(null); setStreaming(true)
    setTitle(''); setBody(''); setHashtagsText('')
    try {
      const res = await fetch('/api/marketing/generate/stream', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: candidate.jobId, channel: ch }),
      })
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.includes('ndjson') || !res.body) {
        // Disabled / error came back as plain JSON — surface it, then try the fallback.
        let msg = 'Could not generate that post.'
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* ignore */ }
        const ok = await fallbackGenerate()
        if (!ok) setGenError(msg)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let sawDelta = false
      let finished = false
      while (!finished) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
          if (!line) continue
          let evt: { t: string; text?: string; piece?: ContentPiece; error?: string }
          try { evt = JSON.parse(line) } catch { continue }
          if (evt.t === 'delta' && evt.text) { sawDelta = true; setBody(prev => prev + evt.text) }
          else if (evt.t === 'done' && evt.piece) { applyPiece(evt.piece); onDraftChange?.(evt.piece); finished = true }
          else if (evt.t === 'error') {
            if (!sawDelta && await fallbackGenerate()) { finished = true; break }
            setGenError(evt.error || 'Generation failed.'); finished = true
          }
        }
      }
    } catch {
      if (!await fallbackGenerate()) setGenError('Could not reach the generator. Try again.')
    } finally {
      setStreaming(false)
    }
  }

  // ── No draft yet (and not mid-stream) → the generate CTA ──
  if (!draft && !streaming) {
    return (
      <div className="rounded-card border border-dashed border-border-strong bg-surface p-6 text-center space-y-3">
        <div className="w-11 h-11 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto">
          <Sparkles className="w-5 h-5 text-accent" />
        </div>
        <p className="text-sm text-ink-muted max-w-xs mx-auto">
          Draft a {def.label} post for this job in your brand voice — ready to review and post.
        </p>
        <Button onClick={runGenerate} disabled={!aiEnabled}>
          <Sparkles className="w-4 h-4" /> Generate {def.label} post
        </Button>
        {!aiEnabled && <p className="text-[11px] text-ink-faint">Add your Anthropic key to turn on generation.</p>}
        {genError && <p className="text-[11px] text-red-400">{genError}</p>}
      </div>
    )
  }

  async function persist(patch: Partial<Pick<ContentPiece, 'title' | 'body' | 'hashtags' | 'status' | 'published_at'>>) {
    if (!draft) return
    setSaving(true)
    const { data } = await supabase.from('content_pieces').update(patch).eq('id', draft.id).select('*').maybeSingle()
    setSaving(false)
    if (data) { setSaved(true); onDraftChange?.(data as ContentPiece); setTimeout(() => setSaved(false), 1500) }
  }

  function saveEdits() {
    if (streaming || !draft) return
    persist({ title: title.trim() || null, body: body.trim(), hashtags })
  }

  async function markPosted() {
    await persist({ status: 'published', published_at: new Date().toISOString() })
    setPosted(true)
    if (draft?.asset_id) await supabase.from('marketing_assets').update({ status: 'used' }).eq('id', draft.asset_id)
  }

  function copyCaption() {
    const text = [body.trim(), hashtags.map(h => `#${h}`).join(' ')].filter(Boolean).join('\n\n')
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }

  return (
    <div className="space-y-4">
      {/* Editor */}
      <div className="space-y-3">
        {def.usesTitle && (
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            onBlur={saveEdits}
            readOnly={streaming}
            placeholder="Headline"
            className="w-full bg-bg-tertiary border border-border rounded-xl px-3.5 py-2.5 text-sm font-semibold text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        )}
        <textarea
          value={body}
          onChange={e => setBody(e.target.value)}
          onBlur={saveEdits}
          readOnly={streaming}
          rows={6}
          className="w-full bg-bg-tertiary border border-border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50 resize-y min-h-[120px] leading-relaxed"
        />
        {def.usesHashtags && (
          <input
            value={hashtagsText}
            onChange={e => setHashtagsText(e.target.value)}
            onBlur={saveEdits}
            readOnly={streaming}
            placeholder="hashtags (space-separated)"
            className="w-full bg-bg-tertiary border border-border rounded-xl px-3.5 py-2 text-sm text-accent placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50"
          />
        )}
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="secondary" size="sm" onClick={runGenerate} loading={streaming} disabled={!aiEnabled}>
            <RefreshCw className="w-3.5 h-3.5" /> Regenerate
          </Button>
          <span className="text-[11px] text-ink-faint inline-flex items-center gap-1.5">
            {streaming ? <><Loader2 className="w-3 h-3 animate-spin" /> Writing…</>
              : saving ? 'Saving…' : saved ? 'Saved' : `${body.length} chars · target ~${def.maxChars}`}
          </span>
        </div>
      </div>

      {/* Live preview */}
      <ChannelPreview
        ch={ch}
        businessName={businessName}
        logoUrl={logoUrl}
        title={def.usesTitle ? title : null}
        body={body}
        hashtags={def.usesHashtags ? hashtags : []}
        imageUrl={canUsePhoto ? imageUrl : null}
      />

      {genError && <Banner tone="danger" onDismiss={() => setGenError(null)}>{genError}</Banner>}

      {/* Photo consent gate */}
      {imageUrl && !candidate.photoConsent && (
        <Banner
          tone="warn"
          icon={Lock}
          action={candidate.customerId && onGrantConsent ? (
            <Button size="sm" variant="secondary" onClick={onGrantConsent} className="shrink-0">Allow photos</Button>
          ) : undefined}
        >
          This customer hasn’t allowed their photos to be used publicly, so the post is text-only.
        </Banner>
      )}
      {!imageUrl && (
        <p className="text-[11px] text-ink-faint inline-flex items-center gap-1.5">
          <ImageOff className="w-3.5 h-3.5" /> No photo on this job — add before/after photos to make it visual.
        </p>
      )}

      {/* Publish actions (v1: copy + save photo + open the platform). Hidden mid-stream. */}
      {!streaming && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={copyCaption}>
            {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy caption</>}
          </Button>
          {canUsePhoto && (
            <Button variant="secondary" size="sm" onClick={() => downloadImage(imageUrl!, `${(candidate.serviceType || 'post').replace(/\s+/g, '-').toLowerCase()}-${ch}.jpg`)}>
              <Download className="w-3.5 h-3.5" /> Save photo
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => window.open(def.openUrl, '_blank')}>
            <ExternalLink className="w-3.5 h-3.5" /> Open {def.label}
          </Button>
          <button
            type="button"
            onClick={markPosted}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
              posted ? 'text-emerald-400' : 'text-ink-muted hover:text-ink hover:bg-surface',
            )}
          >
            <CheckCircle2 className={cn('w-4 h-4', posted && 'fill-emerald-400/20')} />
            {posted ? 'Posted' : 'Mark as posted'}
          </button>
        </div>
      )}
    </div>
  )
}
