'use client'

import { toast } from '@/lib/toast'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { Banner } from '@/components/ui/Banner'
import { Card } from '@/components/ui/Card'
import { Tabs, type TabItem } from '@/components/ui/Tabs'
import { Button } from '@/components/ui/Button'
import { Collapsible } from '@/components/ui/Collapsible'
import { AssetCard } from './AssetCard'
import { ContentComposer } from './ContentComposer'
import { PostOptionsBar } from './PostOptionsBar'
import { CHANNELS } from '@/lib/marketing/channels'
import { WRITING_STYLES } from '@/lib/marketing/styles'
import { thumbUrl } from '@/lib/photos'
import { formatDate } from '@/lib/utils'
import { Images, Sparkles, Lightbulb, Wand2, SlidersHorizontal } from 'lucide-react'
import { DEFAULT_POST_OPTIONS, type ContentPiece, type GenerateAllResponse, type MarketingCandidate, type MarketingChannel, type PostOptions } from '@/lib/marketing/types'

const CHANNEL_TABS: TabItem[] = CHANNELS.map(c => ({ key: c.key, label: c.label, icon: c.icon }))

export function StudioClient({ candidates, aiEnabled, businessName, logoUrl, userId, initialJobId }: {
  candidates: MarketingCandidate[]
  aiEnabled: boolean
  businessName: string
  logoUrl: string | null
  userId: string
  initialJobId?: string
}) {
  const supabase = useMemo(() => createClient(), [])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(
    (initialJobId && candidates.some(c => c.jobId === initialJobId) ? initialJobId : candidates[0]?.jobId) ?? null,
  )
  const [activeChannel, setActiveChannel] = useState<MarketingChannel>('facebook')
  const [draftsByKey, setDraftsByKey] = useState<Record<string, ContentPiece>>({})
  // Creative controls — shared by per-channel generate AND "Generate all platforms".
  const [options, setOptions] = useState<PostOptions>(DEFAULT_POST_OPTIONS)
  const [genAll, setGenAll] = useState(false)
  const [genAllMsg, setGenAllMsg] = useState<{ tone: 'info' | 'success' | 'danger'; text: string } | null>(null)
  // Per-job photo-marketing consent, lifted here so it survives channel switches.
  const [consentJobs, setConsentJobs] = useState<Set<string>>(
    () => new Set(candidates.filter(c => c.photoConsent).map(c => c.jobId)),
  )
  // Process any of this owner's due scheduled posts on load — this is what makes
  // scheduling work without a paid cron (Vercel Hobby). Fire-and-forget + idempotent.
  useEffect(() => { fetch('/api/marketing/publish/process', { method: 'POST' }).catch(() => {}) }, [])
  // Outcome notice when returning from an account-connect attempt (OAuth flow).
  const [connectNotice, setConnectNotice] = useState<string | null>(null)
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search)
      const c = p.get('connect')
      if (!c) return
      const plat = p.get('platform') || 'that platform'
      setConnectNotice(
        c === 'soon' ? `One-tap publishing for ${plat} is coming soon — add the account under Accounts to schedule and copy-publish now.`
          : c === 'pending' ? 'Account connected — finishing setup. You can publish manually in the meantime.'
          : c === 'denied' ? 'Connection cancelled.'
          : 'Couldn’t complete that connection. Add the account manually for now.',
      )
      const clean = new URL(window.location.href); clean.searchParams.delete('connect'); clean.searchParams.delete('platform')
      window.history.replaceState({}, '', clean.toString())
    } catch { /* ignore */ }
  }, [])

  const base = candidates.find(c => c.jobId === selectedJobId) || null
  // Reflect a freshly-granted consent immediately, without a round-trip.
  const selected = base ? { ...base, photoConsent: base.photoConsent || consentJobs.has(base.jobId) } : null
  const draftKey = `${selectedJobId}:${activeChannel}`

  async function grantConsent(customerId: string, jobId: string) {
    const { error } = await supabase.from('customers')
      .update({ photo_marketing_consent: true, photo_marketing_consent_at: new Date().toISOString() })
      .eq('id', customerId)
    // Only unlock photos when the consent actually saved — a failed write must
    // never leave the UI claiming consent the database doesn't have.
    if (error) { toast.error('Could not save photo consent: ' + error.message); return }
    toast.success('Photo use approved for this customer.')
    setConsentJobs(prev => new Set(prev).add(jobId))
  }

  // One click → a draft for every platform, all in the current options.
  async function generateAll() {
    if (!selected || !aiEnabled || genAll) return
    setGenAll(true); setGenAllMsg(null)
    try {
      const res = await fetch('/api/marketing/generate/all', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId: selected.jobId, options }),
      })
      const j = await res.json() as GenerateAllResponse
      if (j.pieces?.length) {
        setDraftsByKey(prev => {
          const next = { ...prev }
          for (const p of j.pieces) next[`${p.job_id}:${p.channel}`] = p
          return next
        })
      }
      if (!j.aiEnabled) setGenAllMsg({ tone: 'info', text: 'AI isn’t connected yet — add your Anthropic key to generate posts.' })
      else if (!j.pieces?.length) setGenAllMsg({ tone: 'danger', text: 'Could not generate posts. Try again.' })
      else setGenAllMsg({
        tone: j.errors?.length ? 'info' : 'success',
        text: `Generated ${j.pieces.length} post${j.pieces.length > 1 ? 's' : ''}${j.errors?.length ? ` · ${j.errors.length} couldn’t be written` : ' across every platform'}.`,
      })
    } catch {
      setGenAllMsg({ tone: 'danger', text: 'Could not reach the generator. Try again.' })
    } finally {
      setGenAll(false)
    }
  }

  // Load existing drafts for the selected job (newest per channel wins). Fetch each
  // job at most once per session — re-selecting an already-loaded job reuses the
  // draftsByKey cache instead of re-querying content_pieces on every click.
  const loadedJobs = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!selectedJobId || loadedJobs.current.has(selectedJobId)) return
    let active = true
    supabase.from('content_pieces').select('*').eq('job_id', selectedJobId).order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!active) return
        loadedJobs.current.add(selectedJobId)
        const fresh: Record<string, ContentPiece> = {}
        for (const p of (data as ContentPiece[] | null) || []) {
          const k = `${p.job_id}:${p.channel}`
          if (!fresh[k]) fresh[k] = p
        }
        setDraftsByKey(prev => ({ ...prev, ...fresh }))
      })
    return () => { active = false }
  }, [selectedJobId, supabase])

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
      {connectNotice && <Banner tone="info" onDismiss={() => setConnectNotice(null)}>{connectNotice}</Banner>}

      <div className="grid lg:grid-cols-[300px_1fr] gap-5 items-start">
        {/* Ranked candidate list */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint px-1">
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
                      <img src={thumbUrl(selected.bestBeforeUrl, 480, 260)} alt="Before" loading="lazy" className="w-full h-24 object-cover rounded-lg border border-border" />
                      <figcaption className="text-[10px] text-ink-faint text-center mt-1">Before</figcaption>
                    </figure>
                  )}
                  {selected.bestAfterUrl && (
                    <figure className="flex-1 min-w-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={thumbUrl(selected.bestAfterUrl, 480, 260)} alt="After" loading="lazy" className="w-full h-24 object-cover rounded-lg border border-border" />
                      <figcaption className="text-[10px] text-ink-faint text-center mt-1">After</figcaption>
                    </figure>
                  )}
                </div>
              )}
            </Card>

            {/* Create posts — one-click all-platforms, with voice/length tucked away. */}
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm font-semibold text-ink">Create posts</p>
                <Button onClick={generateAll} loading={genAll} disabled={!aiEnabled} title={!aiEnabled ? "Add your Anthropic API key to enable AI generation" : undefined} className="shrink-0">
                  <Wand2 className="w-4 h-4" /> Generate all platforms
                </Button>
              </div>
              <Collapsible
                title="Voice & length"
                icon={SlidersHorizontal}
                summary={`${WRITING_STYLES[options.style].label} · ${options.length[0].toUpperCase()}${options.length.slice(1)}${options.emojis ? ' · emoji' : ''}`}
              >
                <PostOptionsBar options={options} onChange={setOptions} />
              </Collapsible>
              {genAllMsg && (
                <Banner tone={genAllMsg.tone} onDismiss={() => setGenAllMsg(null)}>{genAllMsg.text}</Banner>
              )}
            </Card>

            <Tabs tabs={CHANNEL_TABS} active={activeChannel} onChange={k => setActiveChannel(k as MarketingChannel)} />

            <ContentComposer
              key={draftKey}
              candidate={selected}
              ch={activeChannel}
              draft={draftsByKey[draftKey] || null}
              aiEnabled={aiEnabled}
              businessName={businessName}
              logoUrl={logoUrl}
              userId={userId}
              options={options}
              onDraftChange={piece => setDraftsByKey(prev => ({ ...prev, [`${piece.job_id}:${piece.channel}`]: piece }))}
              onGrantConsent={selected.customerId ? () => grantConsent(selected.customerId!, selected.jobId) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  )
}
