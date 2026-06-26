'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PHOTO_BUCKET } from '@/lib/photos'
import { formatDate } from '@/lib/utils'
import {
  buildPairs, type BeforeAfterPair, type JobLite, type PhotoLite, type PairContext,
} from '@/lib/beforeafter/pairs'
import {
  LAYOUTS, EXPORT_PRESETS, PLATFORM_KEYS, presetByKey, renderComposite, balanceFactor,
  BRAND_ACCENT, type LayoutKey, type Focus, type BrandInfo,
} from '@/lib/beforeafter/layouts'
import { loadImage, averageLuminance } from '@/lib/beforeafter/imageLoad'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import {
  Sparkles, Download, Images, Loader2, Wand2, Tag, BadgeCheck, AlertTriangle,
  SlidersHorizontal, RefreshCw, Layers, ShieldCheck, ChevronDown, ChevronUp, Camera,
} from 'lucide-react'

// ── Before / After Studio ────────────────────────────────────────────────────
// Reads the owner's completed jobs + their before/after photos, pairs them, lets
// AI pick the strongest, then composites a branded post entirely in the browser
// (one renderComposite engine for preview AND export). No new tables, no server
// image processing — the only optional dependency is ANTHROPIC_API_KEY for the
// AI pick, which degrades to the deterministic ranking when absent.

interface Override { beforeId?: string; afterId?: string }
interface AiRank { score: number; rationale: string }

const PREVIEW_LONG_EDGE = 1000

export function BeforeAfterStudio() {
  const supabase = useMemo(() => createClient(), [])

  const [loading, setLoading] = useState(true)
  const [pairs, setPairs] = useState<BeforeAfterPair[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [consentSupported, setConsentSupported] = useState(true)
  const [brand, setBrand] = useState<BrandInfo>({ name: 'Edge Property Services', phone: null, website: null, logo: null, accent: BRAND_ACCENT })

  // Composition controls — kept global so they persist as you switch pairs.
  const [layout, setLayout] = useState<LayoutKey>('auto')
  const [presetKey, setPresetKey] = useState<string>('instagram')
  const [showLabels, setShowLabels] = useState(true)
  const [showBranding, setShowBranding] = useState(true)
  const [autoBalance, setAutoBalance] = useState(true)
  const [labelBefore, setLabelBefore] = useState('Before')
  const [labelAfter, setLabelAfter] = useState('After')
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [beforeFocus, setBeforeFocus] = useState<Focus>({ x: 0.5, y: 0.5 })
  const [afterFocus, setAfterFocus] = useState<Focus>({ x: 0.5, y: 0.5 })
  const [showTune, setShowTune] = useState(false)

  // AI ranking state.
  const [aiBusy, setAiBusy] = useState(false)
  const [aiRanks, setAiRanks] = useState<Record<string, AiRank>>({})
  const [aiHeadline, setAiHeadline] = useState<string | null>(null)
  const [aiNote, setAiNote] = useState<string | null>(null)

  const [downloading, setDownloading] = useState(false)
  const [previewError, setPreviewError] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  function publicUrl(path: string): string {
    return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
  }

  // ── Load everything ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (alive) setLoading(false); return }

      const { data: photoRows } = await supabase
        .from('job_photos')
        .select('id,storage_path,kind,taken_at,caption,property_id,job_id')
        .eq('user_id', user.id)
        .in('kind', ['before', 'after'])
      const photos: PhotoLite[] = ((photoRows as Array<{ id: string; storage_path: string; kind: string; taken_at: string; caption: string | null; property_id: string | null; job_id: string | null }>) || []).map(r => ({
        id: r.id,
        url: publicUrl(r.storage_path),
        kind: r.kind as PhotoLite['kind'],
        taken_at: r.taken_at,
        caption: r.caption,
        property_id: r.property_id,
        job_id: r.job_id,
      }))

      const jobIds = Array.from(new Set(photos.map(p => p.job_id).filter((x): x is string => !!x)))
      let jobs: JobLite[] = []
      if (jobIds.length) {
        const { data: jobRows } = await supabase
          .from('jobs')
          .select('id,title,service_type,scheduled_date,completed_at,customer_id,property_id')
          .eq('user_id', user.id)
          .eq('status', 'completed')
          .in('id', jobIds)
        jobs = (jobRows as JobLite[]) || []
      }

      const custIds = Array.from(new Set(jobs.map(j => j.customer_id).filter((x): x is string => !!x)))
      const propIds = Array.from(new Set(jobs.map(j => j.property_id).filter((x): x is string => !!x)))

      // Consent column is from a recent migration — feature-detect so the Studio
      // still works if it hasn't been applied yet.
      const consentMap = new Map<string, boolean | null>()
      const nameMap = new Map<string, string | null>()
      let consentOk = true
      if (custIds.length) {
        const rich = await supabase.from('customers').select('id,name,photo_marketing_consent').in('id', custIds)
        if (rich.error) {
          consentOk = false
          const basic = await supabase.from('customers').select('id,name').in('id', custIds)
          for (const c of (basic.data as Array<{ id: string; name: string | null }>) || []) nameMap.set(c.id, c.name)
        } else {
          for (const c of (rich.data as Array<{ id: string; name: string | null; photo_marketing_consent: boolean | null }>) || []) {
            nameMap.set(c.id, c.name)
            consentMap.set(c.id, c.photo_marketing_consent)
          }
        }
      }

      const propMap = new Map<string, { address: string | null; neighborhood: string | null }>()
      if (propIds.length) {
        const { data: propRows } = await supabase.from('properties').select('id,address,neighborhood').in('id', propIds)
        for (const p of (propRows as Array<{ id: string; address: string | null; neighborhood: string | null }>) || []) {
          propMap.set(p.id, { address: p.address, neighborhood: p.neighborhood })
        }
      }

      const { data: settings } = await supabase
        .from('business_settings')
        .select('company_name,logo_url,phone,website,email_primary')
        .eq('user_id', user.id)
        .maybeSingle()
      const s = settings as { company_name: string | null; logo_url: string | null; phone: string | null; website: string | null; email_primary: string | null } | null

      const contexts = new Map<string, PairContext>()
      for (const j of jobs) {
        const prop = j.property_id ? propMap.get(j.property_id) : undefined
        contexts.set(j.id, {
          customerName: j.customer_id ? nameMap.get(j.customer_id) ?? null : null,
          address: prop?.address ?? null,
          neighborhood: prop?.neighborhood ?? null,
          consent: j.customer_id ? consentMap.get(j.customer_id) ?? (consentOk ? false : null) : null,
        })
      }

      const built = buildPairs(jobs, photos, contexts, Date.now())

      // Resolve the logo to an <img> for canvas branding (best-effort).
      let logo: HTMLImageElement | null = null
      if (s?.logo_url) { try { logo = await loadImage(s.logo_url) } catch { logo = null } }

      if (!alive) return
      setConsentSupported(consentOk)
      setBrand({
        name: s?.company_name || 'Edge Property Services',
        phone: s?.phone || null,
        website: s?.website || null,
        logo,
        accent: BRAND_ACCENT,
      })
      setPairs(built)
      setSelectedJobId(built[0]?.jobId ?? null)
      setLoading(false)
    }
    load()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(() => pairs.find(p => p.jobId === selectedJobId) || null, [pairs, selectedJobId])

  // Resolve current before/after photos honoring per-pair swaps.
  const resolvedBefore: PhotoLite | null = useMemo(() => {
    if (!selected) return null
    const ov = overrides[selected.jobId]?.beforeId
    return (ov && selected.beforeOptions.find(p => p.id === ov)) || selected.before
  }, [selected, overrides])
  const resolvedAfter: PhotoLite | null = useMemo(() => {
    if (!selected) return null
    const ov = overrides[selected.jobId]?.afterId
    return (ov && selected.afterOptions.find(p => p.id === ov)) || selected.after
  }, [selected, overrides])

  // ── Build a RenderInput at a given canvas size (shared by preview + export) ──
  const buildInput = useCallback(async (width: number, height: number) => {
    if (!resolvedBefore || !resolvedAfter) return null
    const [bImg, aImg] = await Promise.all([loadImage(resolvedBefore.url), loadImage(resolvedAfter.url)])
    let beforeBrightness = 1
    let afterBrightness = 1
    if (autoBalance) {
      const bl = averageLuminance(bImg, resolvedBefore.id)
      const al = averageLuminance(aImg, resolvedAfter.id)
      const target = (bl + al) / 2
      beforeBrightness = balanceFactor(bl, target)
      afterBrightness = balanceFactor(al, target)
    }
    return {
      before: bImg, after: aImg, width, height, layout,
      showLabels, showBranding, brand,
      beforeFocus, afterFocus, beforeBrightness, afterBrightness,
      labelBefore: labelBefore || 'Before', labelAfter: labelAfter || 'After',
    }
  }, [resolvedBefore, resolvedAfter, autoBalance, layout, showLabels, showBranding, brand, beforeFocus, afterFocus, labelBefore, labelAfter])

  // ── Live preview ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function draw() {
      const canvas = canvasRef.current
      if (!canvas || !selected) return
      const preset = presetByKey(presetKey)
      const ar = preset.w / preset.h
      const pw = ar >= 1 ? PREVIEW_LONG_EDGE : Math.round(PREVIEW_LONG_EDGE * ar)
      const ph = ar >= 1 ? Math.round(PREVIEW_LONG_EDGE / ar) : PREVIEW_LONG_EDGE
      const input = await buildInput(pw, ph)
      if (cancelled || !input) { if (!input) setPreviewError(true); return }
      setPreviewError(false)
      canvas.width = pw
      canvas.height = ph
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      renderComposite(ctx, input)
    }
    draw().catch(() => { if (!cancelled) setPreviewError(true) })
    return () => { cancelled = true }
  }, [selected, presetKey, buildInput])

  // ── Export ──────────────────────────────────────────────────────────────────
  const renderToBlob = useCallback(async (presetK: string): Promise<Blob | null> => {
    const preset = presetByKey(presetK)
    const input = await buildInput(preset.w, preset.h)
    if (!input) return null
    const canvas = document.createElement('canvas')
    canvas.width = preset.w
    canvas.height = preset.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    renderComposite(ctx, input)
    return await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.92))
  }, [buildInput])

  const triggerDownload = useCallback((blob: Blob, presetK: string) => {
    const preset = presetByKey(presetK)
    const name = `edge-before-after-${slug(selected?.context.customerName || selected?.job.title || 'job')}-${preset.key}-${preset.w}x${preset.h}.jpg`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [selected])

  async function downloadOne(presetK: string) {
    setDownloading(true)
    try {
      const blob = await renderToBlob(presetK)
      if (blob) triggerDownload(blob, presetK)
    } finally {
      setDownloading(false)
    }
  }

  async function downloadAllPlatforms() {
    setDownloading(true)
    try {
      for (const k of PLATFORM_KEYS) {
        const blob = await renderToBlob(k)
        if (blob) triggerDownload(blob, k)
        await new Promise(r => setTimeout(r, 350)) // let each download register
      }
    } finally {
      setDownloading(false)
    }
  }

  // ── AI pick ─────────────────────────────────────────────────────────────────
  async function pickStrongest() {
    if (!pairs.length) return
    setAiBusy(true)
    setAiNote(null)
    try {
      const candidates = pairs.slice(0, 6).map(p => ({
        jobId: p.jobId,
        label: [p.context.customerName, p.job.service_type, p.context.neighborhood].filter(Boolean).join(' · ') || p.job.title,
        beforeUrl: p.before.url,
        afterUrl: p.after.url,
      }))
      const res = await fetch('/api/grow/before-after/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidates }),
      })
      const data = await res.json()
      if (data.disabled) {
        setAiNote('AI picks need an ANTHROPIC_API_KEY — showing the smart ranking instead.')
        return
      }
      if (!data.ok) {
        setAiNote('Could not reach the AI just now — showing the smart ranking instead.')
        return
      }
      const ranks: Record<string, AiRank> = {}
      for (const r of data.ranking as Array<{ jobId: string; score: number; rationale: string }>) {
        ranks[r.jobId] = { score: r.score, rationale: r.rationale }
      }
      setAiRanks(ranks)
      setAiHeadline(data.headline || null)
      if (data.bestJobId) setSelectedJobId(data.bestJobId)
      // Re-order the gallery by the AI score (fall back to deterministic).
      setPairs(prev => [...prev].sort((a, b) => (ranks[b.jobId]?.score ?? b.score) - (ranks[a.jobId]?.score ?? a.score)))
    } catch {
      setAiNote('Could not reach the AI just now — showing the smart ranking instead.')
    } finally {
      setAiBusy(false)
    }
  }

  // ── Consent ─────────────────────────────────────────────────────────────────
  async function allowPhotos() {
    if (!selected?.job.customer_id) return
    const cid = selected.job.customer_id
    await supabase.from('customers').update({ photo_marketing_consent: true, photo_marketing_consent_at: new Date().toISOString() }).eq('id', cid)
    setPairs(prev => prev.map(p => p.job.customer_id === cid ? { ...p, context: { ...p.context, consent: true } } : p))
  }

  function setBeforePhoto(id: string) {
    if (!selected) return
    setOverrides(prev => ({ ...prev, [selected.jobId]: { ...prev[selected.jobId], beforeId: id } }))
  }
  function setAfterPhoto(id: string) {
    if (!selected) return
    setOverrides(prev => ({ ...prev, [selected.jobId]: { ...prev[selected.jobId], afterId: id } }))
  }
  function resetFraming() {
    setBeforeFocus({ x: 0.5, y: 0.5 })
    setAfterFocus({ x: 0.5, y: 0.5 })
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Card className="p-10 flex items-center justify-center text-ink-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" /> Finding your before &amp; after photos…
      </Card>
    )
  }

  if (!pairs.length) {
    return (
      <Card className="p-8 text-center">
        <div className="w-12 h-12 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-3">
          <Camera className="w-6 h-6 text-accent" />
        </div>
        <p className="text-sm font-semibold text-ink">No before/after pairs yet</p>
        <p className="text-xs text-ink-muted mt-1 max-w-md mx-auto">
          On a completed visit, snap a <span className="text-amber-300 font-medium">Before</span> and an{' '}
          <span className="text-emerald-300 font-medium">After</span> photo (the camera buttons on the job).
          Any completed job with both will show up here, ready to turn into a post.
        </p>
      </Card>
    )
  }

  const aiUsed = Object.keys(aiRanks).length > 0
  const consentBlocked = consentSupported && selected?.context.consent === false

  return (
    <div className="space-y-4">
      {/* AI pick bar */}
      <Card className="p-3 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
            <Sparkles className="w-4 h-4 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Pick the strongest pair</p>
            <p className="text-xs text-ink-muted truncate">
              {aiHeadline ? <>“{aiHeadline}” — AI’s pick of {pairs.length}.</> : <>Let AI compare your {pairs.length} pair{pairs.length !== 1 ? 's' : ''} and choose the most eye-catching.</>}
            </p>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={pickStrongest} loading={aiBusy} className="shrink-0">
          <Wand2 className="w-4 h-4" /> {aiUsed ? 'Re-pick with AI' : 'Pick strongest with AI'}
        </Button>
      </Card>
      {aiNote && (
        <p className="text-[11px] text-amber-300/90 flex items-center gap-1.5 -mt-2 px-1"><AlertTriangle className="w-3 h-3" /> {aiNote}</p>
      )}

      {/* Gallery strip */}
      <div className="flex gap-2.5 overflow-x-auto pb-1.5 -mx-1 px-1">
        {pairs.map(p => {
          const rank = aiRanks[p.jobId]
          const score = rank?.score ?? p.score
          const isSel = p.jobId === selectedJobId
          return (
            <button key={p.jobId} onClick={() => setSelectedJobId(p.jobId)}
              className={`shrink-0 w-44 rounded-xl border text-left overflow-hidden transition-colors ${isSel ? 'border-accent ring-1 ring-accent/40' : 'border-border hover:border-border-strong'}`}>
              <div className="grid grid-cols-2 gap-px bg-border aspect-[2/1]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.before.url} alt="before" loading="lazy" className="w-full h-full object-cover" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.after.url} alt="after" loading="lazy" className="w-full h-full object-cover" />
              </div>
              <div className="p-2">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium text-ink truncate">{p.context.customerName || p.job.title}</span>
                  <span className={`text-[10px] font-bold tabular-nums shrink-0 ${rank ? 'text-accent' : 'text-ink-faint'}`}>{score}</span>
                </div>
                <p className="text-[10px] text-ink-faint truncate">{p.job.service_type || 'Service'} · {formatDate(p.job.completed_at || p.job.scheduled_date)}</p>
                {rank?.rationale && <p className="text-[10px] text-ink-muted mt-1 line-clamp-2">{rank.rationale}</p>}
              </div>
            </button>
          )
        })}
      </div>

      {/* Consent gate */}
      {consentBlocked && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 flex flex-col sm:flex-row sm:items-center gap-2.5">
          <ShieldCheck className="w-4 h-4 text-amber-300 shrink-0" />
          <p className="text-xs text-amber-200/90 flex-1">
            <span className="font-semibold">{selected?.context.customerName || 'This customer'}</span> hasn’t cleared their photos for public marketing.
            Get a quick OK before you post, then mark it here.
          </p>
          <Button size="sm" variant="secondary" onClick={allowPhotos} className="shrink-0 border-amber-500/40 text-amber-200">
            <BadgeCheck className="w-4 h-4" /> Mark allowed
          </Button>
        </div>
      )}

      {/* Editor: preview + controls */}
      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        {/* Preview — canvas stays mounted (error shows as an overlay) so picking
            another pair always redraws. */}
        <Card className="p-4 flex flex-col items-center justify-center bg-bg-tertiary min-h-[320px]">
          <div className="relative w-full flex items-center justify-center">
            <canvas ref={canvasRef} className={`max-h-[58vh] max-w-full w-auto h-auto rounded-lg shadow-lg ${previewError ? 'opacity-20' : ''}`} />
            {previewError && (
              <div className="absolute inset-0 flex items-center justify-center text-center text-ink-muted text-sm px-4">
                <span>
                  <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-amber-400" />
                  Couldn’t load one of the photos. Try another pair or re-upload it.
                </span>
              </div>
            )}
          </div>
          {selected && (
            <p className="text-[11px] text-ink-faint mt-3 text-center">
              {presetByKey(presetKey).label} · {presetByKey(presetKey).w}×{presetByKey(presetKey).h}
              {selected.context.consent === true && <span className="text-emerald-400"> · cleared to post</span>}
            </p>
          )}
        </Card>

        {/* Controls */}
        <div className="space-y-3">
          {/* Layout */}
          <Card className="p-3">
            <SectionLabel icon={Layers}>Layout</SectionLabel>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {LAYOUTS.map(l => (
                <Chip key={l.key} active={layout === l.key} onClick={() => setLayout(l.key)} title={l.hint}>{l.label}</Chip>
              ))}
            </div>
          </Card>

          {/* Size */}
          <Card className="p-3">
            <SectionLabel icon={Images}>Size</SectionLabel>
            <p className="text-[10px] uppercase tracking-wide text-ink-faint mt-2 mb-1">Platform</p>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_PRESETS.filter(p => p.group === 'Platform').map(p => (
                <Chip key={p.key} active={presetKey === p.key} onClick={() => setPresetKey(p.key)} title={`${p.w}×${p.h}${p.note ? ' · ' + p.note : ''}`}>{p.label}</Chip>
              ))}
            </div>
            <p className="text-[10px] uppercase tracking-wide text-ink-faint mt-3 mb-1">Format</p>
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_PRESETS.filter(p => p.group === 'Format').map(p => (
                <Chip key={p.key} active={presetKey === p.key} onClick={() => setPresetKey(p.key)} title={`${p.w}×${p.h}`}>{p.label}</Chip>
              ))}
            </div>
          </Card>

          {/* Toggles */}
          <Card className="p-3 space-y-2">
            <SectionLabel icon={Tag}>Style</SectionLabel>
            <Toggle on={showLabels} onToggle={() => setShowLabels(v => !v)} label="Before / After labels" />
            <Toggle on={showBranding} onToggle={() => setShowBranding(v => !v)} label="Branding footer" />
            <Toggle on={autoBalance} onToggle={() => setAutoBalance(v => !v)} label="Smart exposure balance" />
            {showLabels && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                <input value={labelBefore} onChange={e => setLabelBefore(e.target.value)} placeholder="Before"
                  className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
                <input value={labelAfter} onChange={e => setLabelAfter(e.target.value)} placeholder="After"
                  className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
              </div>
            )}
          </Card>

          {/* Fine-tune */}
          <Card className="p-3">
            <button onClick={() => setShowTune(v => !v)} className="w-full flex items-center justify-between">
              <SectionLabel icon={SlidersHorizontal}>Fine-tune framing</SectionLabel>
              {showTune ? <ChevronUp className="w-4 h-4 text-ink-faint" /> : <ChevronDown className="w-4 h-4 text-ink-faint" />}
            </button>
            {showTune && selected && (
              <div className="mt-3 space-y-3">
                <FocusRow label="Before" focus={beforeFocus} onChange={setBeforeFocus} />
                <FocusRow label="After" focus={afterFocus} onChange={setAfterFocus} />
                <button onClick={resetFraming} className="text-[11px] text-accent hover:underline flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Reset framing
                </button>
                {selected.beforeOptions.length > 1 && (
                  <SwapRow label="Swap before" photos={selected.beforeOptions} activeId={resolvedBefore?.id} onPick={setBeforePhoto} />
                )}
                {selected.afterOptions.length > 1 && (
                  <SwapRow label="Swap after" photos={selected.afterOptions} activeId={resolvedAfter?.id} onPick={setAfterPhoto} />
                )}
              </div>
            )}
          </Card>

          {/* Export */}
          <Card className="p-3 space-y-2">
            <SectionLabel icon={Download}>Download</SectionLabel>
            <Button onClick={() => downloadOne(presetKey)} loading={downloading} className="w-full">
              <Download className="w-4 h-4" /> Download {presetByKey(presetKey).label}
            </Button>
            <Button variant="secondary" onClick={downloadAllPlatforms} loading={downloading} className="w-full">
              <Images className="w-4 h-4" /> Download all platforms ({PLATFORM_KEYS.length})
            </Button>
            <p className="text-[10px] text-ink-faint text-center">Saves a ready-to-post image. Nothing is published automatically.</p>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ── Small UI atoms ────────────────────────────────────────────────────────────
function SectionLabel({ icon: Icon, children }: { icon: typeof Images; children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint flex items-center gap-1.5"><Icon className="w-3.5 h-3.5" /> {children}</p>
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      className={`text-xs font-medium rounded-lg px-2.5 py-1.5 border transition-colors ${active ? 'bg-accent/15 border-accent/40 text-accent' : 'border-border text-ink-muted hover:text-ink hover:border-border-strong'}`}>
      {children}
    </button>
  )
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button onClick={onToggle} className="w-full flex items-center justify-between text-xs text-ink py-0.5">
      <span>{label}</span>
      <span className={`w-9 h-5 rounded-full border transition-colors relative ${on ? 'bg-accent/30 border-accent/50' : 'bg-bg-tertiary border-border'}`}>
        <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all ${on ? 'left-[18px] bg-accent' : 'left-0.5 bg-ink-faint'}`} />
      </span>
    </button>
  )
}

function FocusRow({ label, focus, onChange }: { label: string; focus: Focus; onChange: (f: Focus) => void }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">{label} framing</p>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-ink-faint w-3">↔</span>
        <input type="range" min={0} max={100} value={Math.round(focus.x * 100)} onChange={e => onChange({ ...focus, x: Number(e.target.value) / 100 })} className="flex-1 accent-accent h-1" />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] text-ink-faint w-3">↕</span>
        <input type="range" min={0} max={100} value={Math.round(focus.y * 100)} onChange={e => onChange({ ...focus, y: Number(e.target.value) / 100 })} className="flex-1 accent-accent h-1" />
      </div>
    </div>
  )
}

function SwapRow({ label, photos, activeId, onPick }: { label: string; photos: PhotoLite[]; activeId?: string; onPick: (id: string) => void }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">{label}</p>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {photos.map(p => (
          <button key={p.id} onClick={() => onPick(p.id)}
            className={`shrink-0 w-12 h-12 rounded-lg overflow-hidden border-2 ${activeId === p.id ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100'}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt="" loading="lazy" className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  )
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job'
}
