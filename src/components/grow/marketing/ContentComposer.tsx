'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { ChannelPreview } from './ChannelPreview'
import { RewriteToolbar } from './RewriteToolbar'
import { PublishPanel } from './PublishPanel'
import { downloadForPlatform } from '@/lib/marketing/platformImage'
import { channel as channelDef } from '@/lib/marketing/channels'
import { lengthChars } from '@/lib/marketing/prompt'
import { parseHashtags } from '@/lib/marketing/publishQueue'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Sparkles, RefreshCw, ImageOff, Lock, Loader2, Gauge, Pencil, Eye } from 'lucide-react'
import { DEFAULT_POST_OPTIONS, type ContentPiece, type MarketingCandidate, type MarketingChannel, type PostOptions, type PostText, type QualityScore, type RewriteAction, type RewriteResponse } from '@/lib/marketing/types'

// The deterministic quality score lives on the saved piece's meta.
function pieceQuality(piece: ContentPiece | null): { score: QualityScore; note: string } | null {
  const meta = piece?.meta as { quality?: QualityScore; qualityNote?: string } | undefined
  if (!meta?.quality || typeof meta.quality.total !== 'number') return null
  return { score: meta.quality, note: meta.qualityNote || '' }
}
function scoreTone(total: number): string {
  if (total >= 85) return 'text-emerald-400'
  if (total >= 72) return 'text-accent'
  return 'text-amber-400'
}

export function ContentComposer({ candidate, ch, draft, aiEnabled, businessName, logoUrl, userId, options = DEFAULT_POST_OPTIONS, onDraftChange, onGrantConsent }: {
  candidate: MarketingCandidate
  ch: MarketingChannel
  draft: ContentPiece | null
  aiEnabled: boolean
  businessName: string
  logoUrl: string | null
  userId: string
  options?: PostOptions
  onDraftChange?: (piece: ContentPiece) => void
  onGrantConsent?: () => void
}) {
  const def = channelDef(ch)
  const supabase = useMemo(() => createClient(), [])
  // The on-screen char target tracks the chosen length + this platform.
  const charTarget = lengthChars(ch, options.length)
  const showHashtagField = def.usesHashtags && options.hashtags

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [hashtagsText, setHashtagsText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [rewriting, setRewriting] = useState<RewriteAction | null>(null)
  // Developer/debug mode (?debug=1) surfaces the quality breakdown + "why it's stronger".
  const [debug, setDebug] = useState(false)
  useEffect(() => { try { setDebug(new URLSearchParams(window.location.search).get('debug') === '1') } catch { /* ignore */ } }, [])

  const quality = useMemo(() => pieceQuality(draft), [draft])

  // Reset the editable fields whenever a different draft is shown (new generation).
  useEffect(() => {
    setTitle(draft?.title || '')
    setBody(draft?.body || '')
    setHashtagsText((draft?.hashtags || []).join(' '))
    setSaved(false)
  }, [draft?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const hashtags = useMemo(() => parseHashtags(hashtagsText), [hashtagsText])
  const imageUrl = candidate.bestAfterUrl || candidate.bestBeforeUrl
  const canUsePhoto = !!imageUrl && candidate.photoConsent

  function applyPiece(piece: ContentPiece) {
    setTitle(piece.title || '')
    setBody(piece.body || '')
    setHashtagsText((piece.hashtags || []).join(' '))
  }

  // Non-streaming fallback (used if streaming is unavailable or fails before any text).
  async function fallbackGenerate(): Promise<boolean> {
    try {
      const res = await fetch('/api/marketing/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: candidate.jobId, channel: ch, options }),
      })
      const j = await res.json()
      if (j?.ok && j.piece) { applyPiece(j.piece); onDraftChange?.(j.piece); return true }
      if (j?.error) setGenError(j.error)
      return false
    } catch { return false }
  }

  // Stream the post in live (the "watch it write" path).
  async function runGenerate() {
    // Regenerating over hand-edited text would wipe it — snapshot first and offer a
    // one-tap Undo (the app's confirm→undo convention) once the new draft lands.
    const prior = body.trim() ? { title, body, hashtagsText } : null
    setGenError(null); setStreaming(true); setPolishing(false)
    setTitle(''); setBody(''); setHashtagsText('')
    try {
      const res = await fetch('/api/marketing/generate/stream', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: candidate.jobId, channel: ch, options }),
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
          else if (evt.t === 'polishing') { setPolishing(true) }
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
      setStreaming(false); setPolishing(false)
      if (prior) toast.undo('Replaced your caption.', () => {
        setTitle(prior.title); setBody(prior.body); setHashtagsText(prior.hashtagsText)
        persist({ title: prior.title.trim() || null, body: prior.body.trim(), hashtags: parseHashtags(prior.hashtagsText) })
      })
    }
  }

  // One-click AI rewrite of the current editor text (reuses the shared gateway).
  async function runRewrite(action: RewriteAction) {
    if (streaming || rewriting) return
    setRewriting(action); setGenError(null)
    const payload: PostText = { title: title.trim() || null, body, hashtags }
    try {
      const res = await fetch('/api/marketing/rewrite', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: ch, action, text: payload }),
      })
      const j = await res.json() as RewriteResponse
      if (j.ok && j.text) {
        setTitle(j.text.title || '')
        setBody(j.text.body)
        setHashtagsText((j.text.hashtags || []).join(' '))
        if (draft) persist({ title: j.text.title?.trim() || null, body: j.text.body.trim(), hashtags: j.text.hashtags })
      } else {
        setGenError(j.error || 'Could not rewrite that post.')
      }
    } catch {
      setGenError('Could not reach the rewriter. Try again.')
    } finally {
      setRewriting(null)
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
    else toast.error('Could not save your edits — check your connection and try again.')
  }

  function saveEdits() {
    if (streaming || !draft) return
    persist({ title: title.trim() || null, body: body.trim(), hashtags })
  }

  return (
    <div className="space-y-4">
      {/* Editor — the ONE editable place. Everything below the preview header is
          a read-only mock, so the caption only ever lives here. */}
      <div className="space-y-3 rounded-card border border-accent/30 bg-accent/[0.03] p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-accent inline-flex items-center gap-1.5">
            <Pencil className="w-3.5 h-3.5" /> Your caption
          </span>
          <span className="text-[11px] text-ink-faint">{def.label}</span>
        </div>
        <p className="text-[11px] text-ink-muted -mt-1.5">{def.why}</p>
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
        {showHashtagField && (
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
          <Button variant="secondary" size="sm" onClick={runGenerate} loading={streaming} disabled={!aiEnabled} title={!aiEnabled ? "Add your Anthropic API key to enable AI generation" : undefined}>
            <RefreshCw className="w-3.5 h-3.5" /> Regenerate
          </Button>
          <span className="text-[11px] text-ink-faint inline-flex items-center gap-1.5">
            {polishing ? <><Sparkles className="w-3 h-3 text-accent animate-pulse" /> Polishing for quality…</>
              : streaming ? <><Loader2 className="w-3 h-3 animate-spin" /> Writing…</>
              : rewriting ? <><Loader2 className="w-3 h-3 animate-spin" /> Rewriting…</>
              : saving ? 'Saving…' : saved ? 'Saved' : `${body.length} chars · target ~${charTarget}`}
          </span>
          {!streaming && !rewriting && quality && (
            <span className={cn('text-[11px] font-semibold inline-flex items-center gap-1', scoreTone(quality.score.total))} title="Marketing quality score">
              <Gauge className="w-3 h-3" /> {quality.score.total}/100
            </span>
          )}
        </div>

        {/* Debug: why this post is strong (prompt-quality evaluation) */}
        {debug && quality && (
          <div className="rounded-lg border border-border bg-surface/60 p-2.5 text-[11px] text-ink-muted space-y-1">
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
              <span>hook {quality.score.hook}</span>
              <span>read {quality.score.readability}</span>
              <span>local {quality.score.localRelevance}</span>
              <span>cta {quality.score.ctaStrength}</span>
              <span>orig {quality.score.originality}</span>
              <span>brand {quality.score.brandConsistency}</span>
            </div>
            {quality.note && <p className="text-ink-faint">{quality.note}</p>}
            {quality.score.flags.length > 0 && <p className="text-amber-400/80">flags: {quality.score.flags.join('; ')}</p>}
          </div>
        )}

        {/* One-click AI rewrites of the current text */}
        {body.trim() && aiEnabled && (
          <RewriteToolbar disabled={streaming} busy={rewriting} onRewrite={runRewrite} />
        )}
      </div>

      {/* Live preview — read-only mock of the published post (not editable) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted inline-flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5" /> Live preview
          </span>
          <span className="text-[11px] text-ink-faint inline-flex items-center gap-1">
            <Lock className="w-3 h-3" /> Read-only{canUsePhoto ? ` · photo auto-cropped for ${def.label}` : ''}
          </span>
        </div>
        <ChannelPreview
          ch={ch}
          businessName={businessName}
          logoUrl={logoUrl}
          title={def.usesTitle ? title : null}
          body={body}
          hashtags={showHashtagField ? hashtags : []}
          imageUrl={canUsePhoto ? imageUrl : null}
        />
      </div>

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

      {/* Publishing workflow: schedule / publish to a connected account, or copy & paste. */}
      {!streaming && draft && (
        <>
          <PublishPanel
            piece={draft}
            ch={ch}
            userId={userId}
            hasPhoto={canUsePhoto}
            onSavePhoto={canUsePhoto ? () => downloadForPlatform(imageUrl!, ch, `${(candidate.serviceType || 'post').replace(/\s+/g, '-').toLowerCase()}-${ch}.jpg`) : undefined}
            beforePublish={async () => { await persist({ title: title.trim() || null, body: body.trim(), hashtags }) }}
            onPieceUpdate={p => onDraftChange?.(p)}
          />
        </>
      )}
    </div>
  )
}
