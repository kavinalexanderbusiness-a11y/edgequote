'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Banner } from '@/components/ui/Banner'
import { Card } from '@/components/ui/Card'
import { FilterPill } from '@/components/ui/FilterPill'
import { EmptyState } from '@/components/ui/EmptyState'
import { PostOptionsBar } from './PostOptionsBar'
import { CAMPAIGN_DEFS, campaignDef } from '@/lib/marketing/campaigns'
import { archiveCampaign } from '@/lib/marketing/library'
import { CHANNELS } from '@/lib/marketing/channels'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Megaphone, Sparkles, ArrowRight, Archive, CalendarPlus } from 'lucide-react'
import { DEFAULT_POST_OPTIONS, type CampaignGenerateResponse, type CampaignKind, type MarketingCampaign, type MarketingChannel, type PostOptions } from '@/lib/marketing/types'

export function CampaignBuilder({ aiEnabled, initialCampaigns, initialKind, initialHoliday }: {
  userId: string
  aiEnabled: boolean
  initialCampaigns: MarketingCampaign[]
  initialKind?: CampaignKind
  initialHoliday?: string | null
}) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const [kind, setKind] = useState<CampaignKind>(initialKind || 'spring')
  const def = campaignDef(kind)
  const [name, setName] = useState('')
  // Platform selection is independent of the template and PRESERVED when the template
  // changes (only the initial value comes from the first template's defaults).
  const [channels, setChannels] = useState<MarketingChannel[]>(campaignDef(initialKind || 'spring').defaultChannels)
  const [options, setOptions] = useState<PostOptions>(DEFAULT_POST_OPTIONS)
  const [schedule, setSchedule] = useState(false)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [everyDays, setEveryDays] = useState(2)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [campaigns, setCampaigns] = useState(initialCampaigns)

  // Changing the template keeps the chosen platforms — only swaps the theme.
  function pickKind(k: CampaignKind) {
    setKind(k)
    setError(null)
  }
  function toggleChannel(c: MarketingChannel) {
    setError(null)
    setChannels(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  }
  const allSelected = channels.length === CHANNELS.length
  function selectAll() { setChannels(CHANNELS.map(c => c.key)) }
  function clearAll() { setChannels([]) }

  const count = channels.length

  async function generate() {
    if (!aiEnabled || busy || !count) return
    setBusy(true); setError(null)
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
      const made = j.pieces?.length ?? 0

      // Success (full or partial) → go straight to the generated posts.
      if (made > 0) {
        setCampaigns(prev => (j.campaign ? [j.campaign, ...prev] : prev))
        router.push(j.campaign ? `/dashboard/grow/posts?campaign=${j.campaign.id}` : '/dashboard/grow/posts')
        return
      }

      // Real failure only — surface the actual reason (not a generic message).
      setError(
        j.aiEnabled === false
          ? 'AI isn’t connected yet — add your Anthropic key to generate campaigns.'
          : j.errors?.[0]?.error
            ? `Couldn’t generate any posts: ${j.errors[0].error}`
            : 'Couldn’t generate any posts. Please try again.',
      )
    } catch {
      setError('Couldn’t reach the generator. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function archive(c: MarketingCampaign) {
    setCampaigns(prev => prev.filter(x => x.id !== c.id))
    await archiveCampaign(supabase, c.id, true)
    toast.undo(`Archived "${c.name}".`, async () => {
      await archiveCampaign(supabase, c.id, false)
      setCampaigns(prev => [c, ...prev.filter(x => x.id !== c.id)])
    })
  }

  return (
    <div className="space-y-5">
      {!aiEnabled && <Banner tone="info" icon={Sparkles}>AI isn’t connected yet — add your Anthropic key to generate campaigns.</Banner>}

      {/* Pick a campaign */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">Choose a campaign</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
          {CAMPAIGN_DEFS.map(c => {
            const Icon = c.icon
            const active = kind === c.kind
            return (
              <button key={c.kind} onClick={() => pickKind(c.kind)} className="text-left">
                <Card className={cn('p-3 h-full transition-colors', active ? 'border-accent ring-1 ring-accent/30' : 'hover:border-accent/40')}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn('w-4 h-4', active ? 'text-accent-text' : 'text-ink-muted')} />
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
          <def.icon className="w-4 h-4 text-accent-text" />
          <span className="text-sm font-bold text-ink">{def.label}</span>
          {initialHoliday && <span className="text-xs text-ink-muted">· {initialHoliday}</span>}
        </div>

        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">Campaign name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={def.defaultName}
            className="w-full bg-bg-tertiary border border-border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/50" />
        </label>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Platforms · {count} selected</p>
            <button type="button" onClick={allSelected ? clearAll : selectAll} className="text-[11px] text-accent-text hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
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
                <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="ml-1.5 bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              </label>
              <label className="text-xs text-ink-muted">every
                <input type="number" min={1} max={14} value={everyDays} onChange={e => setEveryDays(Math.max(1, Math.min(14, Number(e.target.value) || 1)))} className="mx-1.5 w-16 bg-bg-tertiary border border-border rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                days
              </label>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <Button onClick={generate} loading={busy} disabled={!aiEnabled || !count}>
            <Megaphone className="w-4 h-4" /> Generate campaign
          </Button>
          <span className="text-[11px] text-ink-faint">
            {count === 0
              ? 'Select at least one platform to generate.'
              : `Will generate ${count} post${count === 1 ? '' : 's'} across ${count} selected platform${count === 1 ? '' : 's'}.`}
          </span>
        </div>

        {error && <Banner tone="danger" onDismiss={() => setError(null)}>{error}</Banner>}
      </Card>

      {/* Existing campaigns */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint mb-2">Your campaigns · {campaigns.length}</p>
        {campaigns.length === 0 ? (
          <EmptyState icon={Megaphone} title="No campaigns yet" description="Pick a theme above and generate your first multi-platform campaign." />
        ) : (
          <div className="grid sm:grid-cols-2 gap-2">
            {campaigns.map(c => {
              const cd = campaignDef(c.kind)
              return (
                <Card key={c.id} className="group p-3 flex items-center gap-3 card-lift">
                  <cd.icon className="w-4 h-4 text-ink-muted shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink truncate">{c.name}</p>
                    <p className="text-xs text-ink-muted">{cd.label} · {c.channels.length} platform{c.channels.length === 1 ? '' : 's'} · {c.status}</p>
                  </div>
                  <Link href={`/dashboard/grow/posts?campaign=${c.id}`} className="text-xs text-accent-text inline-flex items-center gap-1 hover:underline shrink-0">
                    View posts <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
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
