'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
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
import { loadImage, averageLuminance, prefetch } from '@/lib/beforeafter/imageLoad'
import { scorePairUrls, blendPairScore } from '@/lib/beforeafter/imageQuality'
import { computeSmartFocus } from '@/lib/marketing/platformImage'
import { thumbUrl } from '@/lib/photos'
import { getPropertyContext, type PropertyIntelligence } from '@/lib/ai/propertyContext'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  Download, Images, Loader2, Wand2, Tag, BadgeCheck, AlertTriangle,
  SlidersHorizontal, RefreshCw, Layers, ShieldCheck, ChevronDown, ChevronUp, Camera,
  Brain, BookMarked, Crown, CalendarDays, Check,
} from 'lucide-react'

// ── Before / After Studio ────────────────────────────────────────────────────
// Reads the owner's completed jobs + their before/after photos, pairs them, lets
// AI pick the strongest, then composites a branded post entirely in the browser
// (one renderComposite engine for preview AND export). The only optional
// dependency is ANTHROPIC_API_KEY for the AI pick, which degrades to the
// deterministic ranking when absent.
//
// INTEGRATION (part of the one-AI-employee Grow platform, not a silo):
// • Marketing Studio — every pick/export is persisted to `marketing_assets`
//   (the shared contract). Marketing Studio's generator turns those assets into
//   `content_pieces` captions; we never write captions here. Scores/rationale are
//   READ BACK on load, so the work round-trips.
// • Property Intelligence — reuses the cached `property_intelligence` brain via
//   the shared read seam (prompt enrichment server-side + a UI chip). We NEVER
//   re-analyse a property the vision feature already did.
// • Consent — a non-consented customer's asset stays a `candidate` (never
//   promoted to `used`/publishable) and is flagged in the gallery.
// • No duplicate AI — only UNSCORED pairs are sent to the model; saved scores are
//   reused on return (an explicit "re-score" forces a fresh look).

interface Override { beforeId?: string; afterId?: string }
interface AiRank { score: number; rationale: string }
type AssetStatus = 'candidate' | 'used' | 'dismissed'

const PREVIEW_LONG_EDGE = 1000

// Season the asset belongs to (mirrors the server's seasonOf so a client-saved
// asset and a server-saved one agree). Calgary-ish quarters.
function seasonOf(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date()
  const m = d.getMonth()
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'fall'
  return 'winter'
}

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
  // Advanced controls (layout / style / framing) stay hidden behind one toggle —
  // the defaults already compose a finished post, so most owners never open this.
  const [showCustomize, setShowCustomize] = useState(false)

  // AI ranking state.
  const [aiBusy, setAiBusy] = useState(false)
  const [aiRanks, setAiRanks] = useState<Record<string, AiRank>>({})
  const [aiNote, setAiNote] = useState<string | null>(null)
  const [aiDisabled, setAiDisabled] = useState(false) // learned from the server; hides the AI CTA once off

  // Marketing Studio integration: lifecycle of each pair's saved marketing_asset.
  const [assetStatus, setAssetStatus] = useState<Record<string, AssetStatus>>({})
  // Property Intelligence: the selected property's cached brain (reused, not re-run).
  const [pi, setPi] = useState<PropertyIntelligence | null>(null)

  const [downloading, setDownloading] = useState(false)
  const [justDownloaded, setJustDownloaded] = useState(false)
  const [batchDone, setBatchDone] = useState(false) // confirmation for the "All platforms" button
  const [batchProgress, setBatchProgress] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState(false)
  // Which pair the canvas has finished drawing — drives a one-time "rendering…"
  // overlay on a fresh selection (control tweaks redraw from cache, no flicker).
  const [readyJobId, setReadyJobId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const galleryRef = useRef<HTMLDivElement>(null)
  // Latest keyboard-shortcut handlers, so the (once-bound) listener never goes stale.
  const keysRef = useRef<{ prev: () => void; next: () => void; download: () => void }>({ prev: () => {}, next: () => {}, download: () => {} })

  function publicUrl(path: string): string {
    return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
  }

  // ── Load everything ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { if (alive) setLoading(false); return }

      // Bounded jobs-first (mirrors lib/marketing/data.loadMaps): the newest completed
      // jobs, then only THEIR before/after photos — so the Studio never pulls the whole
      // photo history (which silently caps at 1000) or scores non-completed work.
      const { data: jobRows } = await supabase
        .from('jobs')
        .select('id,title,service_type,scheduled_date,completed_at,customer_id,property_id')
        .eq('user_id', user.id)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false, nullsFirst: false })
        .limit(200)
      const jobs: JobLite[] = (jobRows as JobLite[]) || []
      const jobIds = jobs.map(j => j.id)

      let photos: PhotoLite[] = []
      if (jobIds.length) {
        const { data: photoRows } = await supabase
          .from('job_photos')
          .select('id,storage_path,kind,taken_at,caption,property_id,job_id')
          .eq('user_id', user.id)
          .in('kind', ['before', 'after'])
          .in('job_id', jobIds)
        photos = ((photoRows as Array<{ id: string; storage_path: string; kind: string; taken_at: string; caption: string | null; property_id: string | null; job_id: string | null }>) || []).map(r => ({
          id: r.id,
          url: publicUrl(r.storage_path),
          kind: r.kind as PhotoLite['kind'],
          taken_at: r.taken_at,
          caption: r.caption,
          property_id: r.property_id,
          job_id: r.job_id,
        }))
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

      // ── Read back any marketing_assets we already saved for these jobs ─────
      // The shared Marketing Studio contract: a prior AI pick / export persisted
      // its score, rationale, chosen photos and lifecycle. Restoring them means
      // scores show instantly, the model is NOT re-run for already-analysed pairs
      // (no duplicate AI), and the previously chosen before/after is reselected.
      const restoredRanks: Record<string, AiRank> = {}
      const restoredStatus: Record<string, AssetStatus> = {}
      const restoredOverrides: Record<string, Override> = {}
      if (jobIds.length) {
        try {
          const { data: assetRows, error: assetErr } = await supabase
            .from('marketing_assets')
            .select('job_id,quality_score,ai_rationale,status,best_before_photo_id,best_after_photo_id')
            .eq('user_id', user.id)
            .in('job_id', jobIds)
          if (!assetErr) {
            const photoIds = new Set(photos.map(p => p.id))
            for (const a of (assetRows as Array<{ job_id: string; quality_score: number | null; ai_rationale: string | null; status: AssetStatus; best_before_photo_id: string | null; best_after_photo_id: string | null }>) || []) {
              if (a.status) restoredStatus[a.job_id] = a.status
              // ai_rationale present ⇒ this pair was AI-analysed; reuse it.
              if (a.ai_rationale && a.ai_rationale.trim()) {
                restoredRanks[a.job_id] = { score: a.quality_score ?? 0, rationale: a.ai_rationale.trim() }
              }
              const ov: Override = {}
              if (a.best_before_photo_id && photoIds.has(a.best_before_photo_id)) ov.beforeId = a.best_before_photo_id
              if (a.best_after_photo_id && photoIds.has(a.best_after_photo_id)) ov.afterId = a.best_after_photo_id
              if (ov.beforeId || ov.afterId) restoredOverrides[a.job_id] = ov
            }
          }
        } catch { /* table absent / not migrated — Studio still works */ }
      }

      // Order the gallery by the best score we know (saved AI score wins, else the
      // deterministic score) so the strongest pair leads even on a cold load.
      const ordered = [...built].sort((a, b) =>
        (restoredRanks[b.jobId]?.score ?? b.score) - (restoredRanks[a.jobId]?.score ?? a.score))

      if (!alive) return
      setConsentSupported(consentOk)
      setBrand({
        name: s?.company_name || 'Edge Property Services',
        phone: s?.phone || null,
        website: s?.website || null,
        logo: null,
        accent: BRAND_ACCENT,
      })
      setAiRanks(restoredRanks)
      setAssetStatus(restoredStatus)
      setOverrides(restoredOverrides)
      setPairs(ordered)
      setSelectedJobId(ordered[0]?.jobId ?? null)
      setLoading(false)

      // Resolve the branding logo AFTER first paint (best-effort) — the preview
      // re-renders from cache when it arrives (buildInput depends on brand), so the
      // gallery doesn't wait on a logo download to become interactive.
      if (s?.logo_url) {
        loadImage(s.logo_url).then(logo => { if (alive) setBrand(prev => ({ ...prev, logo })) }).catch(() => {})
      }
    }
    load()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Deterministic pixel quality per pair (0..100), computed client-side once the
  // photos load — reuses the ONE image-ranking engine (lib/beforeafter/imageQuality).
  const [pixelScores, setPixelScores] = useState<Record<string, number>>({})
  const [stripExpanded, setStripExpanded] = useState(false) // cap the gallery strip at scale

  // The single blended rank: AI Vision leads when present, else pixels lead the
  // metadata floor (buildPairs.score). Manual override (before/after swap) is
  // separate and always wins in the composer.
  const blendOf = useCallback((p: BeforeAfterPair): number =>
    blendPairScore({ meta: p.score, image: pixelScores[p.jobId] ?? null, ai: aiRanks[p.jobId]?.score ?? null }),
    [pixelScores, aiRanks])

  // Gallery order = strongest first, by the blended score. Derived, so it re-ranks
  // live as pixel scores resolve or the AI pass returns — without mutating `pairs`.
  const orderedPairs = useMemo(() => [...pairs].sort((a, b) => blendOf(b) - blendOf(a)), [pairs, blendOf])

  // Assess each pair's photos once (bounded; loadImage is cached so the preview
  // reuses the bytes). Never throws — a pair that can't be read just keeps its floor.
  useEffect(() => {
    if (!pairs.length) return
    let alive = true
    ;(async () => {
      for (const p of pairs.slice(0, 12)) {
        if (pixelScores[p.jobId] != null) continue
        const s = await scorePairUrls(p.before.url, p.after.url)
        // Commit each score the instant it resolves so tiles settle one by one,
        // instead of the whole gallery re-ranking in a single jolt at the end.
        if (alive && s) setPixelScores(prev => ({ ...prev, [p.jobId]: s.score }))
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs])

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

  // Better default: auto-frame the subject (not the empty sky) whenever the pair or a
  // swapped photo changes, reusing the smart-focus engine so the owner rarely needs the
  // Framing sliders. Keyed on photo identity, so manual slider edits persist until the
  // photo actually changes. loadImage is cached — the preview reuses the same bytes.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (resolvedBefore) { const b = await loadImage(resolvedBefore.url); if (alive) setBeforeFocus(computeSmartFocus(b)) }
        if (resolvedAfter) { const a = await loadImage(resolvedAfter.url); if (alive) setAfterFocus(computeSmartFocus(a)) }
      } catch { /* keep the centre default if a photo can't be read */ }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedBefore?.id, resolvedAfter?.id])

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
      if (!cancelled && selected) setReadyJobId(selected.jobId)
    }
    draw().catch(() => { if (!cancelled) setPreviewError(true) })
    return () => { cancelled = true }
  }, [selected, presetKey, buildInput])

  // ── Prefetch the neighbouring pairs so the next click renders instantly ──────
  // Uses the VISIBLE order (orderedPairs) so we warm the tiles actually adjacent
  // in the gallery, not the raw meta order.
  useEffect(() => {
    if (!selected) return
    const i = orderedPairs.findIndex(p => p.jobId === selected.jobId)
    if (i === -1) return
    for (const n of [orderedPairs[i - 1], orderedPairs[i + 1]]) {
      if (n) { prefetch(n.before.url); prefetch(n.after.url) }
    }
  }, [selected, orderedPairs])

  // ── Property Intelligence (reuse the shared brain, never re-analyse) ─────────
  // When the selected pair changes, read any cached analysis for its property
  // through the SAME seam the AI picker uses. Empty/absent → nothing shown.
  useEffect(() => {
    let alive = true
    setPi(null)
    const propertyId = selected?.job.property_id
    if (!propertyId) return
    getPropertyContext(supabase, propertyId)
      .then(ctx => { if (alive) setPi(ctx) })
      .catch(() => { if (alive) setPi(null) })
    return () => { alive = false }
  }, [selected, supabase])

  // ── Keyboard accelerators (← → switch pairs · D download) ────────────────────
  // Pure shortcuts to actions that already exist; ignored while typing in a field.
  function goRelative(delta: number) {
    const i = orderedPairs.findIndex(p => p.jobId === selectedJobId)
    if (i === -1) return
    const next = orderedPairs[i + delta]
    if (next) setSelectedJobId(next.jobId)
  }
  // Refresh the latest handlers every render so the once-bound listener never goes stale.
  useEffect(() => {
    keysRef.current = {
      prev: () => goRelative(-1),
      next: () => goRelative(1),
      download: () => { if (!downloading && selected) downloadOne(presetKey) },
    }
  })
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowRight') { e.preventDefault(); keysRef.current.next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); keysRef.current.prev() }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); keysRef.current.download() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Keep the selected pair scrolled into view (centered) in the gallery strip.
  useEffect(() => {
    const el = galleryRef.current?.querySelector(`[data-pair="${selectedJobId}"]`) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [selectedJobId])

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
    const biz = slug(brand.name || 'business')
    const name = `${biz}-before-after-${slug(selected?.context.customerName || selected?.job.title || 'job')}-${preset.key}-${preset.w}x${preset.h}.jpg`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [selected, brand])

  // Brief "Downloaded ✓" confirmation on the button (Canva-style feedback).
  function flashDownloaded() {
    setJustDownloaded(true)
    window.setTimeout(() => setJustDownloaded(false), 1800)
  }

  async function downloadOne(presetK: string) {
    setDownloading(true)
    try {
      const blob = await renderToBlob(presetK)
      if (blob) {
        triggerDownload(blob, presetK)
        flashDownloaded()
        if (selected && resolvedBefore && resolvedAfter) await saveAsset(selected, resolvedBefore, resolvedAfter, 'used')
      }
    } finally {
      setDownloading(false)
    }
  }

  async function downloadAllPlatforms() {
    setDownloading(true)
    try {
      let any = false
      for (let i = 0; i < PLATFORM_KEYS.length; i++) {
        setBatchProgress(`${i + 1}/${PLATFORM_KEYS.length}`)
        const blob = await renderToBlob(PLATFORM_KEYS[i])
        if (blob) { triggerDownload(blob, PLATFORM_KEYS[i]); any = true }
        await new Promise(r => setTimeout(r, 350)) // let each download register
      }
      if (any) {
        setBatchDone(true); window.setTimeout(() => setBatchDone(false), 1800) // confirm on the All-platforms button, not the single-download one
        if (selected && resolvedBefore && resolvedAfter) await saveAsset(selected, resolvedBefore, resolvedAfter, 'used')
      }
    } finally {
      setBatchProgress(null)
      setDownloading(false)
    }
  }

  // ── AI pick ─────────────────────────────────────────────────────────────────
  // Incremental by default: only pairs WITHOUT a saved AI score are sent to the
  // model (never re-analyse the same imagery). `force` re-scores everything for a
  // deliberate fresh look. The server persists each scored pair to marketing_assets,
  // so the result survives a reload and feeds Marketing Studio.
  async function pickStrongest(force = false) {
    if (!pairs.length) return
    // Only jump the composer to the winner on a deliberate pick (first run or Re-score);
    // an incremental "Score more" must leave the owner on the pair they're composing.
    const firstPick = Object.keys(aiRanks).length === 0
    const pool = (force ? pairs : pairs.filter(p => !aiRanks[p.jobId])).slice(0, 6)

    // Nothing new to analyse — reuse the saved scores and just jump to the best.
    if (!pool.length) {
      const best = [...pairs].sort((a, b) => blendOf(b) - blendOf(a))[0]
      if (best) setSelectedJobId(best.jobId)
      setAiNote('Every pair is already scored — reusing the saved analysis (no re-run).')
      return
    }

    setAiBusy(true)
    setAiNote(null)
    try {
      const candidates = pool.map(p => ({
        jobId: p.jobId,
        label: [p.context.customerName, p.job.service_type, p.context.neighborhood].filter(Boolean).join(' · ') || p.job.title,
        beforeUrl: p.before.url,
        afterUrl: p.after.url,
        // Lets the server capture this AI pick as a reusable marketing asset.
        beforePhotoId: p.before.id,
        afterPhotoId: p.after.id,
        neighborhood: p.context.neighborhood ?? undefined,
      }))
      const res = await fetch('/api/grow/before-after/select', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidates }),
      })
      const data = await res.json()
      if (data.disabled) {
        setAiDisabled(true) // stop advertising the AI action after we learn it's off
        setAiNote('AI picks need an ANTHROPIC_API_KEY — showing the smart ranking instead.')
        return
      }
      if (!data.ok) {
        setAiNote('Could not reach the AI just now — showing the smart ranking instead.')
        return
      }
      // Merge new scores into whatever we already had (incremental).
      const merged: Record<string, AiRank> = { ...aiRanks }
      const newStatus: Record<string, AssetStatus> = {}
      for (const r of data.ranking as Array<{ jobId: string; score: number; rationale: string }>) {
        merged[r.jobId] = { score: r.score, rationale: r.rationale }
        if (!assetStatus[r.jobId]) newStatus[r.jobId] = 'candidate' // server saved it as a candidate
      }
      setAiRanks(merged)
      if (Object.keys(newStatus).length) setAssetStatus(prev => ({ ...prev, ...newStatus }))
      if (data.bestJobId && (force || firstPick)) setSelectedJobId(data.bestJobId)
      // Re-order the gallery by the best score (AI where known, else deterministic).
      setPairs(prev => [...prev].sort((a, b) => (merged[b.jobId]?.score ?? b.score) - (merged[a.jobId]?.score ?? a.score)))
    } catch {
      setAiNote('Could not reach the AI just now — showing the smart ranking instead.')
    } finally {
      setAiBusy(false)
    }
  }

  // ── Save a reusable marketing asset (Marketing Studio contract) ──────────────
  // Persists the CURRENT pair (with the owner's chosen before/after photos) to
  // marketing_assets so Marketing Studio / Content Library can turn it into a post.
  // Consent-aware: a customer who hasn't cleared their photos stays a `candidate`
  // (never promoted to `used`/publishable). Best-effort + RLS-scoped (insert/update
  // own); omits ai_rationale/quality_score so a prior AI score is preserved.
  const saveAsset = useCallback(async (pair: BeforeAfterPair, before: PhotoLite, after: PhotoLite, intendedStatus: AssetStatus) => {
    const consentClear = !consentSupported || pair.context.consent !== false
    const status: AssetStatus = intendedStatus === 'used' && !consentClear ? 'candidate' : intendedStatus
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      await supabase.from('marketing_assets').upsert({
        user_id: user.id,
        job_id: pair.jobId,
        customer_id: pair.job.customer_id,
        property_id: pair.job.property_id,
        service_type: pair.job.service_type,
        neighborhood: pair.context.neighborhood,
        season: seasonOf(pair.job.completed_at || pair.job.scheduled_date),
        has_before: true,
        has_after: true,
        best_before_photo_id: before.id,
        best_after_photo_id: after.id,
        status,
      }, { onConflict: 'user_id,job_id' })
      setAssetStatus(prev => ({ ...prev, [pair.jobId]: status }))
    } catch { /* table absent / not migrated — export still succeeds */ }
  }, [supabase, consentSupported])

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
  const aiUsed = Object.keys(aiRanks).length > 0
  const unscored = pairs.filter(p => !aiRanks[p.jobId]).length

  // Header matches the Schedule reference: title + a count description + a single
  // right-aligned secondary action. Shown in every state so the screen always
  // says "what am I looking at" before anything else.
  const header = (
    <PageHeader
      title="Before / After Studio"
      description={loading
        ? 'Loading your photos…'
        : pairs.length
          ? `${pairs.length} ready-to-post pair${pairs.length !== 1 ? 's' : ''}`
          : 'Snap a before & after on a completed job to start'}
      action={!loading && pairs.length && !aiDisabled ? (
        <Button variant="secondary" onClick={() => pickStrongest(unscored === 0)} loading={aiBusy}
          title={unscored === 0 ? 'Re-run the AI on every pair' : 'Score the pairs the AI hasn’t scored yet'}>
          {unscored === 0 ? <RefreshCw className="w-4 h-4" /> : <Wand2 className="w-4 h-4" />}
          {unscored === 0 ? 'Re-score' : aiUsed ? 'Score more with AI' : 'Pick strongest with AI'}
        </Button>
      ) : undefined}
    />
  )

  if (loading) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid lg:grid-cols-[1fr_300px] gap-4">
          <Card className="min-h-[320px] bg-bg-tertiary flex items-center justify-center text-ink-faint text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Finding your before &amp; after photos…
          </Card>
          <div className="space-y-3 hidden lg:block">
            {[0, 1, 2].map(i => <Card key={i} className="h-20 bg-bg-tertiary animate-pulse" />)}
          </div>
        </div>
      </div>
    )
  }

  if (!pairs.length) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState icon={Camera} className="py-10" title="No before/after pairs yet"
            description={<>
              On a completed visit, snap a <span className="text-amber-300 font-medium">Before</span> and an{' '}
              <span className="text-emerald-300 font-medium">After</span> photo — any completed job with both lands
              here, ready to turn into a branded post in one tap.
              <Link href="/dashboard/schedule" className="flex items-center justify-center gap-1.5 mt-4 text-xs font-semibold text-accent hover:underline">
                <CalendarDays className="w-3.5 h-3.5" /> Go to today’s jobs
              </Link>
            </>} />
        </Card>
      </div>
    )
  }

  const consentBlocked = consentSupported && selected?.context.consent === false
  // The AI's top-scored pair (for the gallery crown).
  const bestAiJobId = aiUsed
    ? (pairs.reduce<{ id: string; s: number } | null>((acc, p) => {
        const r = aiRanks[p.jobId]
        if (!r) return acc
        return !acc || r.score > acc.s ? { id: p.jobId, s: r.score } : acc
      }, null)?.id ?? null)
    : null
  const previewBusy = !!selected && readyJobId !== selected.jobId && !previewError

  return (
    <div className="space-y-6">
      {header}
      {aiNote && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200/90 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {aiNote}
        </div>
      )}

      {/* Gallery — only shown when there's an actual choice between pairs. */}
      {pairs.length > 1 && (
      <div ref={galleryRef} className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {(stripExpanded ? orderedPairs : orderedPairs.slice(0, 24)).map(p => {
          const rank = aiRanks[p.jobId]
          const score = Math.round(blendOf(p))
          const isSel = p.jobId === selectedJobId
          return (
            <button key={p.jobId} data-pair={p.jobId} onClick={() => setSelectedJobId(p.jobId)}
              aria-pressed={isSel}
              aria-label={`${p.context.customerName || p.job.title}, score ${score}${p.jobId === bestAiJobId ? ', AI pick' : ''}`}
              className={`shrink-0 w-44 rounded-xl border text-left overflow-hidden transition-all duration-200 ${FOCUS_RING} ${isSel ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-border-strong'}`}>
              <div className="relative">
                <div className="grid grid-cols-2 gap-px bg-border aspect-[2/1]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(p.before.url, 240, 240)} alt="before" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbUrl(p.after.url, 240, 240)} alt="after" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                </div>
                {p.jobId === bestAiJobId && (
                  <span className="absolute top-1 right-1 inline-flex items-center gap-0.5 rounded-full bg-accent text-black text-[10px] font-bold px-1.5 py-0.5 shadow">
                    <Crown className="w-2.5 h-2.5" /> AI pick
                  </span>
                )}
              </div>
              <div className="p-2">
                <div className="flex items-center justify-between gap-1">
                  <span className="flex items-center gap-1 min-w-0">
                    {consentSupported && p.context.consent != null && (
                      <span aria-hidden title={p.context.consent ? 'Cleared to post' : 'Not cleared for marketing'}
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.context.consent ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    )}
                    <span className="text-xs font-medium text-ink truncate">{p.context.customerName || p.job.title}</span>
                  </span>
                  <span className={`text-[10px] font-bold tabular-nums shrink-0 ${rank ? 'text-accent' : 'text-ink-faint'}`}>{score}</span>
                </div>
                <p className="text-[10px] text-ink-faint truncate">{p.job.service_type || 'Service'} · {formatDate(p.job.completed_at || p.job.scheduled_date)}</p>
                {assetStatus[p.jobId] === 'used' && (
                  <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-accent"><BookMarked className="w-3 h-3" /> Used</span>
                )}
                {rank?.rationale && <p className="text-[10px] text-ink-muted mt-1 line-clamp-2">{rank.rationale}</p>}
              </div>
            </button>
          )
        })}
        {!stripExpanded && orderedPairs.length > 24 && (
          <button onClick={() => setStripExpanded(true)}
            className={`shrink-0 w-32 rounded-xl border border-dashed border-border text-xs font-medium text-ink-muted hover:text-ink hover:border-border-strong ${FOCUS_RING}`}>
            Show all {orderedPairs.length}
          </button>
        )}
      </div>
      )}

      {/* Consent gate */}
      {consentBlocked && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
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

      {/* Property Intelligence — reused from the shared brain (never re-analysed). */}
      {pi && (pi.summary || (pi.detections || []).length > 0) && (
        <div className="rounded-xl border border-accent/20 bg-accent/[0.06] px-4 py-3 flex items-start gap-3">
          <Brain className="w-4 h-4 text-accent shrink-0 mt-0.5" />
          <div className="min-w-0 text-xs">
            <span className="font-semibold text-ink">Property intelligence</span>
            {pi.summary && <span className="text-ink-muted"> — {pi.summary}</span>}
            {(pi.detections || []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {(pi.detections || []).slice(0, 8).map(d => (
                  <span key={d} className="text-[10px] rounded px-1.5 py-0.5 bg-bg-tertiary border border-border text-ink-muted">{d}</span>
                ))}
              </div>
            )}
            <p className="text-[10px] text-ink-faint mt-1">From a prior AI analysis — reused here, not re-run.</p>
          </div>
        </div>
      )}

      {/* Editor: a hero preview with the size strip right under it, a one-tap
          download, and ALL advanced controls hidden behind one "Customize". */}
      <div className="grid lg:grid-cols-[1fr_300px] gap-4">
        {/* Preview hero — canvas stays mounted (error shows as an overlay) so
            picking another pair always redraws. */}
        <Card className="p-4 sm:p-6 bg-gradient-to-b from-surface to-bg-tertiary">
          <div className="relative w-full flex items-center justify-center min-h-[240px]">
            <canvas ref={canvasRef} role="img"
              aria-label={selected ? `Before and after composite for ${selected.context.customerName || selected.job.title}` : 'Before and after preview'}
              className={`max-h-[46vh] sm:max-h-[58vh] max-w-full w-auto h-auto rounded-xl shadow-2xl ring-1 ring-black/10 transition-opacity duration-200 ${previewError || previewBusy ? 'opacity-30' : 'opacity-100'}`} />
            {previewBusy && !previewError && (
              <div className="absolute inset-0 flex items-center justify-center text-ink-faint">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            )}
            {previewError && (
              <div className="absolute inset-0 flex items-center justify-center text-center text-ink-muted text-sm px-4">
                <span>
                  <AlertTriangle className="w-5 h-5 mx-auto mb-2 text-amber-400" />
                  Couldn’t load one of the photos. Try another pair or re-upload it.
                </span>
              </div>
            )}
          </div>
          {/* Size strip — the one export control kept visible (changing it reshapes
              the preview live). Platforms first, generic shapes subtle. */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {EXPORT_PRESETS.filter(p => p.group === 'Platform').map(p => (
              <Chip key={p.key} active={presetKey === p.key} onClick={() => setPresetKey(p.key)} title={`${p.w}×${p.h}${p.note ? ' · ' + p.note : ''}`}>{p.label}</Chip>
            ))}
            {/* Only Format shapes NOT already covered by a Platform preset — so we don't
                offer two chips (e.g. Portrait vs Instagram) that export identical files. */}
            {EXPORT_PRESETS.filter(p => p.group === 'Format' && !EXPORT_PRESETS.some(q => q.group === 'Platform' && q.w === p.w && q.h === p.h)).map(p => (
              <Chip key={p.key} active={presetKey === p.key} onClick={() => setPresetKey(p.key)} title={`${p.w}×${p.h}`} subtle>{p.label}</Chip>
            ))}
          </div>
          {selected?.context.consent === true && (
            <p className="text-[11px] text-emerald-400 mt-2 text-center flex items-center justify-center gap-1">
              <Check className="w-3 h-3" /> Cleared to post
            </p>
          )}
        </Card>

        {/* Actions — download is the hero; customization is one tap away. */}
        <div className="space-y-3">
          <Card className="p-3 space-y-2">
            <Button size="lg" onClick={() => downloadOne(presetKey)} disabled={downloading} loading={downloading && !batchProgress} className="w-full" title="Download (D)">
              {justDownloaded
                ? <><Check className="w-4 h-4" /> Downloaded</>
                : <><Download className="w-4 h-4" /> Download {presetByKey(presetKey).label}</>}
            </Button>
            <Button variant="secondary" onClick={downloadAllPlatforms} disabled={downloading} loading={downloading && !!batchProgress} className="w-full">
              {batchDone
                ? <><Check className="w-4 h-4" /> Saved all {PLATFORM_KEYS.length}</>
                : <><Images className="w-4 h-4" /> {batchProgress ? `Saving ${batchProgress}…` : `All platforms (${PLATFORM_KEYS.length})`}</>}
            </Button>
            {/* Screen-reader announcement for download progress / completion. */}
            <span className="sr-only" aria-live="polite">
              {justDownloaded ? 'Image downloaded.' : batchProgress ? `Saving image ${batchProgress}.` : ''}
            </span>
          </Card>

          {/* Customize — every advanced control lives here, closed by default. */}
          <Card className="p-3">
            <button onClick={() => setShowCustomize(v => !v)} aria-expanded={showCustomize}
              className={`w-full flex items-center justify-between rounded ${FOCUS_RING}`}>
              <SectionLabel icon={SlidersHorizontal}>Customize</SectionLabel>
              {showCustomize ? <ChevronUp className="w-4 h-4 text-ink-faint" /> : <ChevronDown className="w-4 h-4 text-ink-faint" />}
            </button>
            {showCustomize && (
              <div className="mt-3 space-y-4">
                {/* Layout */}
                <div>
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1.5 flex items-center gap-1"><Layers className="w-3 h-3" /> Layout</p>
                  <div className="flex flex-wrap gap-1.5">
                    {LAYOUTS.map(l => (
                      <Chip key={l.key} active={layout === l.key} onClick={() => setLayout(l.key)} title={l.hint}>{l.label}</Chip>
                    ))}
                  </div>
                </div>
                {/* Style */}
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><Tag className="w-3 h-3" /> Style</p>
                  <Toggle on={showLabels} onToggle={() => setShowLabels(v => !v)} label="Before / After labels" />
                  <Toggle on={showBranding} onToggle={() => setShowBranding(v => !v)} label="Branding footer" />
                  <Toggle on={autoBalance} onToggle={() => setAutoBalance(v => !v)} label="Smart exposure balance" />
                </div>
                {/* Framing */}
                {selected && (
                  <div className="space-y-3">
                    <p className="text-[10px] uppercase tracking-wide text-ink-faint flex items-center gap-1"><SlidersHorizontal className="w-3 h-3" /> Framing</p>
                    {showLabels && (
                      <div className="grid grid-cols-2 gap-2">
                        <input value={labelBefore} onChange={e => setLabelBefore(e.target.value)} placeholder="Before"
                          className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
                        <input value={labelAfter} onChange={e => setLabelAfter(e.target.value)} placeholder="After"
                          className="bg-bg-tertiary border border-border rounded-lg px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" />
                      </div>
                    )}
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
              </div>
            )}
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

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'

function Chip({ active, onClick, children, title, subtle }: { active: boolean; onClick: () => void; children: React.ReactNode; title?: string; subtle?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-pressed={active}
      className={`font-medium rounded-lg border transition-colors ${FOCUS_RING} ${subtle ? 'text-[11px] px-2 py-1' : 'text-xs px-2.5 py-1.5'} ${active ? 'bg-accent/15 border-accent/40 text-accent' : 'border-border text-ink-muted hover:text-ink hover:border-border-strong'}`}>
      {children}
    </button>
  )
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button onClick={onToggle} role="switch" aria-checked={on} aria-label={label}
      className={`w-full flex items-center justify-between text-xs text-ink py-0.5 rounded ${FOCUS_RING}`}>
      <span>{label}</span>
      <span aria-hidden className={`w-9 h-5 rounded-full border transition-colors relative ${on ? 'bg-accent/30 border-accent/50' : 'bg-bg-tertiary border-border'}`}>
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
        <span className="text-[10px] text-ink-faint w-3" aria-hidden>↔</span>
        <input type="range" min={0} max={100} aria-label={`${label} horizontal framing`} value={Math.round(focus.x * 100)} onChange={e => onChange({ ...focus, x: Number(e.target.value) / 100 })} className={`flex-1 accent-accent h-2 py-2 ${FOCUS_RING}`} />
      </div>
      <div className="flex items-center gap-2 mt-1">
        <span className="text-[10px] text-ink-faint w-3" aria-hidden>↕</span>
        <input type="range" min={0} max={100} aria-label={`${label} vertical framing`} value={Math.round(focus.y * 100)} onChange={e => onChange({ ...focus, y: Number(e.target.value) / 100 })} className={`flex-1 accent-accent h-2 py-2 ${FOCUS_RING}`} />
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
          <button key={p.id} onClick={() => onPick(p.id)} aria-label={label} aria-pressed={activeId === p.id}
            className={`shrink-0 w-12 h-12 rounded-lg overflow-hidden border-2 ${FOCUS_RING} ${activeId === p.id ? 'border-accent' : 'border-transparent opacity-70 hover:opacity-100'}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumbUrl(p.url, 120, 120)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  )
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job'
}
