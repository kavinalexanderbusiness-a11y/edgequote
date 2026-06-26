'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { Card } from '@/components/ui/Card'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { AssetCard } from './AssetCard'
import { ContentComposer } from './ContentComposer'
import { CHANNELS } from '@/lib/marketing/channels'
import { formatDate } from '@/lib/utils'
import { Images, Sparkles, Lightbulb } from 'lucide-react'
import type { ContentPiece, MarketingCandidate, MarketingChannel } from '@/lib/marketing/types'

const CHANNEL_TABS: TabItem[] = CHANNELS.map(c => ({ key: c.key, label: c.label, icon: c.icon }))

export function StudioClient({ candidates, aiEnabled, businessName, logoUrl, initialJobId }: {
  candidates: MarketingCandidate[]
  aiEnabled: boolean
  businessName: string
  logoUrl: string | null
  initialJobId?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    (initialJobId && candidates.some(c => c.jobId === initialJobId) ? initialJobId : candidates[0]?.jobId) ?? null,
  )
  const [activeChannel, setActiveChannel] = useState<MarketingChannel>('facebook')
  const [draftsByKey, setDraftsByKey] = useState<Record<string, ContentPiece>>({})
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Per-job photo-marketing consent, lifted here so it survives channel switches.
  const [consentJobs, setConsentJobs] = useState<Set<string>>(
    () => new Set(candidates.filter(c => c.photoConsent).map(c => c.jobId)),
  )

  const base = candidates.find(c => c.jobId === selectedJobId) || null
  // Reflect a freshly-granted consent immediately, without a round-trip.
  const selected = base ? { ...base, photoConsent: base.photoConsent || consentJobs.has(base.jobId) } : null
  const draftKey = `${selectedJobId}:${activeChannel}`

  async function grantConsent(customerId: string, jobId: string) {
    await supabase.from('customers')
      .update({ photo_marketing_consent: true, photo_marketing_consent_at: new Date().toISOString() })
      .eq('id', customerId)
    setConsentJobs(prev => new Set(prev).add(jobId))
  }

  // Load existing drafts for the selected job (newest per channel wins).
  useEffect(() => {
    if (!selectedJobId) return
    let active = true
    supabase.from('content_pieces').select('*').eq('job_id', selectedJobId).order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!active) return
        const fresh: Record<string, ContentPiece> = {}
        for (const p of (data as ContentPiece[] | null) || []) {
          const k = `${p.job_id}:${p.channel}`
          if (!fresh[k]) fresh[k] = p
        }
        setDraftsByKey(prev => ({ ...prev, ...fresh }))
      })
    return () => { active = false }
  }, [selectedJobId, supabase])

  async function generate(ch: MarketingChannel) {
    if (!selectedJobId) return
    setGenerating(true); setError(null)
    try {
      const res = await fetch('/api/marketing/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: selectedJobId, channel: ch }),
      })
      const json = await res.json()
      if (json.ok && json.piece) {
        setDraftsByKey(prev => ({ ...prev, [`${selectedJobId}:${ch}`]: json.piece }))
      } else {
        setError(json.error || 'Could not generate that post.')
      }
    } catch {
      setError('Could not reach the generator. Try again.')
    } finally {
      setGenerating(false)
    }
  }

  if (!candidates.length) {
    return (
      <div>
        <PageHeader title="Marketing Studio" description="Turn finished jobs into ready-to-post marketing." />
        <EmptyState
          icon={Images}
          title="No postable jobs yet"
          description="Finish a job and add before/after photos. Completed jobs show up here automatically, ranked by how good a post they'd make."
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Marketing Studio" description="Turn finished jobs into ready-to-post marketing — in your brand voice." />

      {!aiEnabled && (
        <Banner tone="info" icon={Sparkles}>
          AI isn’t connected yet, so posts can’t be generated. Add your Anthropic key to switch it on — you can still browse your postable jobs below.
        </Banner>
      )}

      <div className="grid lg:grid-cols-[300px_1fr] gap-5 items-start">
        {/* Ranked candidate list */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint px-1">
            Postable jobs · {candidates.length}
          </p>
          <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-0.5">
            {candidates.map(c => (
              <AssetCard
                key={c.jobId}
                candidate={c}
                selected={c.jobId === selectedJobId}
                onClick={() => setSelectedJobId(c.jobId)}
              />
            ))}
          </div>
        </div>

        {/* Composer */}
        {selected && (
          <div className="space-y-4 min-w-0">
            <Card className="p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-ink truncate">{selected.serviceType || 'Completed job'}</p>
                  <p className="text-xs text-ink-muted truncate">
                    {[selected.neighborhood || selected.city, selected.customerName, selected.date ? formatDate(selected.date) : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-xl bg-accent/[0.06] border border-accent/15 px-3 py-2">
                <Lightbulb className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                <p className="text-xs text-ink-muted">{selected.rationale}</p>
              </div>
              {(selected.bestBeforeUrl || selected.bestAfterUrl) && (
                <div className="flex gap-2">
                  {selected.bestBeforeUrl && (
                    <figure className="flex-1 min-w-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={selected.bestBeforeUrl} alt="Before" className="w-full h-24 object-cover rounded-lg border border-border" />
                      <figcaption className="text-[10px] text-ink-faint text-center mt-1">Before</figcaption>
                    </figure>
                  )}
                  {selected.bestAfterUrl && (
                    <figure className="flex-1 min-w-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={selected.bestAfterUrl} alt="After" className="w-full h-24 object-cover rounded-lg border border-border" />
                      <figcaption className="text-[10px] text-ink-faint text-center mt-1">After</figcaption>
                    </figure>
                  )}
                </div>
              )}
            </Card>

            <Tabs tabs={CHANNEL_TABS} active={activeChannel} onChange={k => setActiveChannel(k as MarketingChannel)} />

            {error && <Banner tone="danger" onDismiss={() => setError(null)}>{error}</Banner>}

            <ContentComposer
              key={draftKey}
              candidate={selected}
              ch={activeChannel}
              draft={draftsByKey[draftKey] || null}
              businessName={businessName}
              logoUrl={logoUrl}
              generating={generating}
              onGenerate={() => generate(activeChannel)}
              onDraftChange={piece => setDraftsByKey(prev => ({ ...prev, [`${piece.job_id}:${piece.channel}`]: piece }))}
              onGrantConsent={selected.customerId ? () => grantConsent(selected.customerId!, selected.jobId) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  )
}
