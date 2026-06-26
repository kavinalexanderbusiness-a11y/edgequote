'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Card } from '@/components/ui/Card'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { PostOptionsBar } from './PostOptionsBar'
import { CAMPAIGN_DEFS, campaignDef } from '@/lib/marketing/campaigns'
import { archiveCampaign } from '@/lib/marketing/library'
import { CHANNELS, channel as channelDef } from '@/lib/marketing/channels'
import { cn } from '@/lib/utils'
import { Megaphone, Sparkles, Copy, Check, ExternalLink, ArrowRight, Archive, CalendarPlus } from 'lucide-react'
import { DEFAULT_POST_OPTIONS, type CampaignGenerateResponse, type CampaignKind, type ContentPiece, type MarketingCampaign, type MarketingChannel, type PostOptions } from '@/lib/marketing/types'

export function CampaignBuilder({ aiEnabled, initialCampaigns, initialKind, initialHoliday }: {
  userId: string
  aiEnabled: boolean
  initialCampaigns: MarketingCampaign[]
  initialKind?: CampaignKind
  initialHoliday?: string | null
}) {
  const supabase = useMemo(() => createClient(), [])
  const [kind, setKind] = useState<CampaignKind>(initialKind || 'spring')
  const def = campaignDef(kind)
  const [name, setName] = useState('')
  const [channels, setChannels] = useState<MarketingChannel[]>(def.defaultChannels)
  const [options, setOptions] = useState<PostOptions>(DEFAULT_POST_OPTIONS)
  const [schedule, setSchedule] = useState(false)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [everyDays, setEveryDays] = useState(2)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ pieces: ContentPiece[]; msg: string; tone: 'success' | 'info' | 'danger' } | null>(null)
  const [campaigns, setCampaigns] = useState(initialCampaigns)

  function pickKind(k: CampaignKind) {
    setKind(k)
    setChannels(campaignDef(k).defaultChannels)
    setResult(null)
  }
  function toggleChannel(c: MarketingChannel) {
    setChannels(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  }

  async function generate() {
    if (!aiEnabled || busy || !channels.length) return
    setBusy(true); setResult(null)
    try {
      const res = await fetch('/api/marketing/campaign/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind, name: name.trim() || undefined, channels, options,
          holiday: initialHoliday || null,
          scheduleFrom: schedule ? startDate : null, scheduleEveryDays: everyDays,
        }),
      })
      const j = await res.json() as CampaignGenerateResponse
      if (j.campaign) setCampaigns(prev => [j.campaign!, ...prev])
      if (j.pieces?.length) {
        setResult({
          pieces: j.pieces,
          tone: j.errors?.length ? 'info' : 'success',
          msg: `Generated ${j.pieces.length} post${j.pieces.length > 1 ? 's' : ''}${j.errors?.length ? ` · ${j.errors.length} failed` : ''}${schedule ? ' and scheduled them' : ''}.`,
        })
      } else {
        setResult({ pieces: [], tone: 'danger', msg: j.aiEnabled === false ? 'AI isn’t connected yet.' : 'Could not generate the campaign. Try again.' })
      }
    } catch {
      setResult({ pieces: [], tone: 'danger', msg: 'Could not reach the generator. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  async function archive(c: MarketingCampaign) {
    await archiveCampaign(supabase, c.id, true)
    setCampaigns(prev => prev.filter(x => x.id !== c.id))
  }

  return (
    <div className="space-y-5">
      {!aiEnabled && <Banner tone="info" icon={Sparkles}>AI isn’t connected yet — add your Anthropic key to generate campaigns.</Banner>}

      {/* Pick a campaign */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">Choose a campaign</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {CAMPAIGN_DEFS.map(c => {
            const Icon = c.icon
            const active = kind === c.kind
            return (
              <button key={c.kind} onClick={() => pickKind(c.kind)} className="text-left">
                <Card className={cn('p-3 h-full transition-colors', active ? 'border-accent ring-1 ring-accent/30' : 'hover:border-accent/40')}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn('w-4 h-4', active ? 'text-accent' : 'text-ink-muted')} />
                    <span className="text-sm font-semibold text-ink">{c.label}</span>
                  </div>
                  <p className="text-xs text-ink-muted leading-snug">{c.description}</p>
                </Card>
              </button>
            )
          })}
        </div>
      </div>

      {/* Configure */}
      <Card className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <def.icon className="w-4 h-4 text-accent" />
          <span className="text-sm font-bold text-ink">{def.label}</span>
          {initialHoliday && <span className="text-xs text-ink-muted">· {initialHoliday}</span>}
        </div>

        <input value={name} onChange={e => setName(e.target.value)} placeholder={def.defaultName}
          className="w-full bg-bg-tertiary border border-border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50" />

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-1.5">Platforms · {channels.length}</p>
          <div className="flex gap-1.5 flex-wrap">
            {CHANNELS.map(c => (
              <FilterPill key={c.key} active={channels.includes(c.key)} onClick={() => toggleChannel(c.key)}>
                <c.icon className="w-3 h-3" /> {c.label}
              </FilterPill>
            ))}
          </div>
        </div>

        <PostOptionsBar options={options} onChange={setOptions} />

        <div className="flex items-center gap-3 flex-wrap">
          <FilterPill active={schedule} onClick={() => setSchedule(s => !s)}><CalendarPlus className="w-3 h-3" /> Spread across the calendar</FilterPill>
          {schedule && (
            <>
              <label className="text-xs text-ink-muted">From
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="ml-1.5 bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-sm text-ink" />
              </label>
              <label className="text-xs text-ink-muted">every
                <input type="number" min={1} max={14} value={everyDays} onChange={e => setEveryDays(Math.max(1, Math.min(14, Number(e.target.value) || 1)))} className="mx-1.5 w-16 bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-sm text-ink" />
                days
              </label>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={generate} loading={busy} disabled={!aiEnabled || !channels.length}>
            <Megaphone className="w-4 h-4" /> Generate campaign
          </Button>
          <span className="text-[11px] text-ink-faint">One post per selected platform, in your brand voice.</span>
        </div>

        {result && (
          <div className="space-y-2">
            <Banner tone={result.tone}>{result.msg}</Banner>
            {result.pieces.map(p => <ResultRow key={p.id} piece={p} />)}
          </div>
        )}
      </Card>

      {/* Existing campaigns */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint mb-2">Your campaigns · {campaigns.length}</p>
        {campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} title="No campaigns yet" description="Pick a theme above and generate your first multi-platform campaign." />
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {campaigns.map(c => {
              const cd = campaignDef(c.kind)
              return (
                <Card key={c.id} className="p-3 flex items-center gap-3">
                  <cd.icon className="w-4 h-4 text-ink-muted shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink truncate">{c.name}</p>
                    <p className="text-xs text-ink-muted">{cd.label} · {c.channels.length} platform{c.channels.length === 1 ? '' : 's'} · {c.status}</p>
                  </div>
                  <Link href={`/dashboard/grow/posts?campaign=${c.id}`} className="text-xs text-accent inline-flex items-center gap-1 hover:underline shrink-0">
                    View posts <ArrowRight className="w-3 h-3" />
                  </Link>
                  <button onClick={() => archive(c)} className="text-ink-faint hover:text-ink shrink-0" title="Archive"><Archive className="w-4 h-4" /></button>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function ResultRow({ piece }: { piece: ContentPiece }) {
  const def = channelDef(piece.channel)
  const [copied, setCopied] = useState(false)
  function copy() {
    const text = [piece.body, piece.hashtags.map(h => `#${h}`).join(' ')].filter(Boolean).join('\n\n')
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-xs font-semibold text-ink inline-flex items-center gap-1.5"><def.icon className="w-3.5 h-3.5" /> {def.label}</span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={copy}>{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}</Button>
          <Button size="sm" variant="ghost" onClick={() => window.open(def.openUrl, '_blank')}><ExternalLink className="w-3.5 h-3.5" /></Button>
        </div>
      </div>
      {piece.title && <p className="text-sm font-medium text-ink">{piece.title}</p>}
      <p className="text-xs text-ink-muted whitespace-pre-wrap leading-relaxed">{piece.body}</p>
      {piece.hashtags.length > 0 && <p className="text-[11px] text-accent mt-1 break-words">{piece.hashtags.map(h => `#${h}`).join(' ')}</p>}
    </Card>
  )
}
