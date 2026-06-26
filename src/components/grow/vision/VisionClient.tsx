'use client'

import { useMemo, useState } from 'react'
import { Sparkles, Search, MapPin, Image as ImageIcon, Satellite, Eye, RefreshCw, AlertTriangle, Home, Brain, Activity } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { PHOTO_BUCKET } from '@/lib/photos'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Tabs } from '@/components/ui/Tabs'
import { SectionHeading } from '@/components/ui/SectionHeading'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { IntelligenceReport } from './IntelligenceReport'
import { TwinPanel } from './TwinPanel'
import { PropertyTimeline } from './PropertyTimeline'
import { cn } from '@/lib/utils'
import { toneSoft } from '@/lib/tone'
import { DIFFICULTY_LABELS } from '@/lib/vision/labels'
import type { AnalyzeResponse, ConfidenceBand, Difficulty, PropertyIntelligence, PropertyTwin } from '@/lib/vision/types'

// One property as the picker needs it (built server-side in the page).
export interface VisionPropertyLite {
  id: string
  address: string
  city: string | null
  neighborhood: string | null
  hasLocation: boolean
  customerName: string | null
  photoCount: number
  hasAnalysis: boolean
  confidence_band: ConfidenceBand | null
  mowing_difficulty: Difficulty | null
  analyzedAt: string | null
}

const BAND_TONE = { high: 'success', medium: 'warn', low: 'danger' } as const

export function VisionClient({ properties, aiEnabled }: { properties: VisionPropertyLite[]; aiEnabled: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(properties[0]?.id ?? null)
  const [intel, setIntel] = useState<PropertyIntelligence | null>(null)
  const [twin, setTwin] = useState<PropertyTwin | null>(null)
  const [timeline, setTimeline] = useState<PropertyIntelligence[]>([])
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({})
  const [loadingIntel, setLoadingIntel] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reused, setReused] = useState(false)
  const [tab, setTab] = useState<'now' | 'timeline'>('now')

  const selected = properties.find(p => p.id === selectedId) || null

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return properties
    return properties.filter(p =>
      p.address.toLowerCase().includes(q) ||
      (p.customerName || '').toLowerCase().includes(q) ||
      (p.neighborhood || '').toLowerCase().includes(q)
    )
  }, [properties, query])

  async function loadTimeline(id: string) {
    const [timelineRes, photosRes] = await Promise.all([
      supabase.from('property_intelligence').select('*').eq('property_id', id).order('created_at', { ascending: false }).limit(24),
      supabase.from('job_photos').select('id, storage_path').eq('property_id', id),
    ])
    setTimeline((timelineRes.data as unknown as PropertyIntelligence[]) || [])
    const map: Record<string, string> = {}
    for (const ph of (photosRes.data as { id: string; storage_path: string }[] | null) || []) {
      map[ph.id] = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(ph.storage_path).data.publicUrl
    }
    setPhotoUrls(map)
  }

  async function selectProperty(id: string) {
    setSelectedId(id)
    setIntel(null); setTwin(null); setTimeline([]); setError(null); setReused(false); setTab('now')
    setLoadingIntel(true)
    try {
      const [intelRes, twinRes] = await Promise.all([
        supabase.from('property_intelligence').select('*').eq('property_id', id).eq('status', 'active').order('created_at', { ascending: false }).limit(1).maybeSingle(),
        supabase.from('property_twin').select('*').eq('property_id', id).maybeSingle(),
        loadTimeline(id),
      ])
      if (intelRes.data) setIntel(intelRes.data as unknown as PropertyIntelligence)
      if (twinRes.data) setTwin(twinRes.data as unknown as PropertyTwin)
    } finally {
      setLoadingIntel(false)
    }
  }

  async function analyze(force: boolean) {
    if (!selected) return
    setAnalyzing(true); setError(null); setReused(false)
    try {
      const res = await fetch('/api/vision/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: selected.id, includeSatellite: true, force }),
      })
      const data = (await res.json()) as AnalyzeResponse
      if (!data.ok || !data.intelligence) { setError(data.error || 'Analysis failed. Please try again.'); return }
      setIntel(data.intelligence)
      if (data.twin) setTwin(data.twin)
      setReused(!!data.reused)
      await loadTimeline(selected.id)
    } catch {
      setError('Network error — please try again.')
    } finally {
      setAnalyzing(false)
    }
  }

  const canAnalyze = !!selected && aiEnabled && (selected.hasLocation || selected.photoCount > 0)

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="AI Vision"
        description="A living digital twin of every property — it reads imagery, remembers what it saw, tracks change over time, and recommends what's next. Recommendations only."
      />

      {!aiEnabled && (
        <Banner tone="warn" icon={Sparkles}>
          AI isn’t connected yet. Add your <span className="font-semibold">ANTHROPIC_API_KEY</span> on the server to enable AI Vision — everything else stays browsable.
        </Banner>
      )}

      {properties.length === 0 ? (
        <Card className="p-6"><InlineEmpty icon={Home}>No properties yet. Add a property (with a location or photos) to analyze it.</InlineEmpty></Card>
      ) : (
        <div className="grid lg:grid-cols-[20rem_1fr] gap-5">
          {/* Property picker */}
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-faint" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search properties…"
                className="w-full rounded-xl bg-surface border border-border pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40" />
            </div>
            <div className="rounded-card border border-border bg-surface divide-y divide-border max-h-[70vh] overflow-y-auto">
              {filtered.length === 0 ? (
                <InlineEmpty>No matches</InlineEmpty>
              ) : filtered.map(p => {
                const active = p.id === selectedId
                return (
                  <button key={p.id} onClick={() => selectProperty(p.id)}
                    className={cn('w-full text-left px-3.5 py-3 transition-colors', active ? 'bg-accent/10' : 'hover:bg-surface-raised')}>
                    <p className="text-sm font-semibold text-ink truncate">{p.address}</p>
                    <p className="text-[11px] text-ink-faint truncate">{p.customerName || 'No customer'}{p.neighborhood ? ` · ${p.neighborhood}` : ''}</p>
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      {p.hasLocation && <Chip icon={Satellite}>Satellite</Chip>}
                      {p.photoCount > 0 && <Chip icon={ImageIcon}>{p.photoCount}</Chip>}
                      {p.hasAnalysis && p.confidence_band && (
                        <span className={cn('inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border', toneSoft[BAND_TONE[p.confidence_band]])}>
                          <Brain className="w-2.5 h-2.5" />{p.mowing_difficulty ? DIFFICULTY_LABELS[p.mowing_difficulty] : p.confidence_band}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Detail */}
          <div className="space-y-4 min-w-0">
            {!selected ? (
              <Card className="p-6"><InlineEmpty icon={Eye}>Select a property to analyze.</InlineEmpty></Card>
            ) : (
              <>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-ink flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-accent" />{selected.address}</p>
                      <p className="text-[11px] text-ink-faint mt-0.5">{selected.customerName || 'No customer'}{selected.neighborhood ? ` · ${selected.neighborhood}` : ''}</p>
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        <Chip icon={Satellite} muted={!selected.hasLocation}>{selected.hasLocation ? 'Satellite available' : 'No location'}</Chip>
                        <Chip icon={ImageIcon} muted={selected.photoCount === 0}>{selected.photoCount} photo{selected.photoCount === 1 ? '' : 's'}</Chip>
                        {twin && <Chip icon={Brain}>{twin.analysis_count} on file</Chip>}
                      </div>
                    </div>
                    <Button onClick={() => analyze(!!intel)} loading={analyzing} disabled={!canAnalyze} variant={intel ? 'secondary' : 'primary'}>
                      {intel ? <><RefreshCw className="w-4 h-4" /> Re-analyze</> : <><Sparkles className="w-4 h-4" /> Analyze</>}
                    </Button>
                  </div>
                  {!canAnalyze && aiEnabled && (
                    <p className="text-[11px] text-ink-faint mt-2 flex items-center gap-1.5"><AlertTriangle className="w-3 h-3 text-amber-400" /> Add a photo or set this property’s location to analyze it.</p>
                  )}
                </Card>

                {reused && intel && <Banner tone="neutral" icon={Eye}>Showing the existing analysis — the imagery hasn’t changed since it was last run. Use “Re-analyze” to force a fresh read.</Banner>}
                {error && <Banner tone="danger" icon={AlertTriangle}>{error}</Banner>}

                {(twin || timeline.length > 0) && !analyzing && (
                  <Tabs
                    active={tab}
                    onChange={k => setTab(k as 'now' | 'timeline')}
                    tabs={[
                      { key: 'now', label: 'Now', icon: Brain },
                      { key: 'timeline', label: 'Timeline', icon: Activity, count: timeline.length },
                    ]}
                  />
                )}

                {analyzing ? (
                  <div className="space-y-4">
                    <Skeleton className="h-24 w-full rounded-card" />
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-20 rounded-card" />)}</div>
                    <Skeleton className="h-40 w-full rounded-card" />
                  </div>
                ) : loadingIntel ? (
                  <Skeleton className="h-40 w-full rounded-card" />
                ) : tab === 'timeline' ? (
                  <PropertyTimeline entries={timeline} photoUrlById={photoUrls} />
                ) : (twin || intel) ? (
                  <div className="space-y-6">
                    {twin && <TwinPanel twin={twin} />}
                    {intel && (
                      <div>
                        <SectionHeading icon={Eye} title="This analysis" sub="The latest raw read" />
                        <IntelligenceReport intel={intel} />
                      </div>
                    )}
                  </div>
                ) : (
                  <Card className="p-6"><InlineEmpty icon={Sparkles}>{canAnalyze ? 'No analysis yet. Run AI Vision to read this property and start its memory.' : 'Add imagery first.'}</InlineEmpty></Card>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({ icon: Icon, children, muted }: { icon: typeof Satellite; children: React.ReactNode; muted?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border',
      muted ? 'bg-surface text-ink-faint border-border' : 'bg-surface-raised text-ink-muted border-border-strong')}>
      <Icon className="w-2.5 h-2.5" />{children}
    </span>
  )
}
