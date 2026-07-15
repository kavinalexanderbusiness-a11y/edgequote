'use client'
import { toast } from '@/lib/toast'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Button } from '@/components/ui/Button'
import { Menu } from '@/components/ui/Menu'
import { Toggle } from '@/components/ui/Toggle'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { FilterPill } from '@/components/ui/FilterPill'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { CrmCampaign, CampaignKind, CampaignAudience, CampaignSchedule, CrmCampaignPreset } from '@/types'
import { DEFAULT_TEMPLATES, MSG_VARIABLES, MsgType } from '@/lib/comms/templates'
import {
  CAMPAIGN_KINDS, CAMPAIGN_PRESETS, AUDIENCE_LABELS, SEASONAL_TEMPLATES,
  describeSchedule, describeNextRun, type CampaignPreset,
} from '@/lib/crm/campaigns'
import { loadCampaignStats, summarizeStats, EMPTY_STATS, type CampaignStats } from '@/lib/crm/campaignStats'
import { previewAudience } from '@/lib/crm/audience'
import { applyCanAskForReview } from '@/lib/crm/reviews'
import { confirm as confirmDialog } from '@/lib/confirm'
import { CampaignHistory } from './CampaignHistory'
import { CampaignPreview } from './CampaignPreview'
import { cn } from '@/lib/utils'
import {
  Megaphone, Cake, PartyPopper, Coffee, Repeat, Plus, Trash2, ChevronDown,
  Leaf, Users, Star, Bookmark, Copy, Send,
} from 'lucide-react'

// The variables a campaign body can actually use. The full MSG_VARIABLES list is
// for job/quote/invoice messages — a campaign has no visit or amount attached, so
// offering {{eta}} or {{amount}} would render an empty string and quietly produce
// a broken sentence. These four are the ones the cron can genuinely fill.
const CAMPAIGN_VARS = new Set(['first_name', 'business_name', 'review_link', 'portal_link'])

const NUM_INPUT = 'bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-base sm:text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

const KIND_ICON: Record<CampaignKind, typeof Cake> = {
  birthday: Cake, anniversary: PartyPopper, win_back: Coffee, broadcast: Repeat,
  seasonal: Leaf, referral: Users, review: Star,
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

interface Draft {
  name: string
  channels: string[]
  custom_body: string
  subject: string
  audience: CampaignAudience
  schedule: CampaignSchedule
}

// The unified Campaign Manager: every kind is a row of crm_campaigns, sent daily
// by /api/cron/campaigns through the existing comms pipeline. Per-customer
// SMS/email consent still gates every send — this UI only decides WHO and WHEN,
// never HOW to send.
export function CampaignManager() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [campaigns, setCampaigns] = useState<CrmCampaign[]>([])
  const [presets, setPresets] = useState<CrmCampaignPreset[]>([])
  const [statsById, setStatsById] = useState<Record<string, CampaignStats>>({})
  const [loading, setLoading] = useState(true)
  const [counts, setCounts] = useState({ total: 0, birthday: 0, anniversary: 0, notReviewed: 0, happy: 0 })
  const [biz, setBiz] = useState({ name: '', reviewUrl: null as string | null })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)

  async function load() {
    const { data: { session } } = await supabase.auth.getSession()
    const user = session?.user
    setUid(user?.id || null)
    if (!user) { setLoading(false); return }
    const head = { count: 'exact' as const, head: true }
    const [campRes, presetRes, totalRes, bdayRes, annivRes, notRevRes, happyRes, bizRes] = await Promise.all([
      supabase.from('crm_campaigns').select('*').eq('user_id', user.id).is('archived_at', null).order('created_at', { ascending: true }),
      supabase.from('crm_campaign_presets').select('*').eq('user_id', user.id).order('name'),
      supabase.from('customers').select('id', head).eq('user_id', user.id).is('archived_at', null),
      supabase.from('customers').select('id', head).eq('user_id', user.id).is('archived_at', null).not('birthday', 'is', null),
      supabase.from('customers').select('id', head).eq('user_id', user.id).is('archived_at', null).not('anniversary', 'is', null),
      // THE review rule, shared with the cron and the campaign audience — a
      // hand-rolled copy here would drift from what the sender actually does.
      applyCanAskForReview(supabase.from('customers').select('id', head).eq('user_id', user.id).is('archived_at', null)),
      supabase.from('customers').select('id', head).eq('user_id', user.id).is('archived_at', null).not('reviewed_at', 'is', null).gte('review_rating', 4),
      supabase.from('business_settings').select('company_name, review_url').eq('user_id', user.id).maybeSingle(),
    ])
    const camps = (campRes.data as CrmCampaign[]) || []
    setCampaigns(camps)
    const b = bizRes.data as { company_name: string | null; review_url: string | null } | null
    setBiz({ name: b?.company_name || '', reviewUrl: b?.review_url ?? null })
    // Presets are additive — a missing table (migration not yet run) must not
    // blank the whole manager.
    setPresets((presetRes.data as CrmCampaignPreset[]) || [])
    setCounts({
      total: totalRes.count || 0, birthday: bdayRes.count || 0, anniversary: annivRes.count || 0,
      notReviewed: notRevRes.count || 0, happy: happyRes.count || 0,
    })
    setLoading(false)
    if (camps.length) setStatsById(await loadCampaignStats(supabase, camps.map(c => c.id)))
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('crm_campaigns', uid ? `user_id=eq.${uid}` : null, load)

  // Both built-in presets and owner-saved ones create a campaign the same way —
  // one insert path, always disabled, so nothing can start sending on creation.
  async function createFrom(p: CampaignPreset | CrmCampaignPreset) {
    if (!uid) return
    setCreating(true)
    const { data, error } = await supabase.from('crm_campaigns').insert({
      user_id: uid, name: p.name, kind: p.kind, enabled: false,
      channels: p.channels, template_key: null,
      custom_body: p.custom_body ?? null,
      subject: p.subject ?? null,
      audience: p.audience, schedule: p.schedule,
    }).select().single()
    setCreating(false)
    if (error || !data) { toast.error('Could not create campaign: ' + error?.message); return }
    await load()
    startEdit(data as CrmCampaign)
  }

  function startEdit(c: CrmCampaign) {
    setEditingId(c.id)
    setDraft({
      name: c.name,
      channels: c.channels?.length ? [...c.channels] : ['email'],
      custom_body: c.custom_body || '',
      subject: c.subject || '',
      audience: { ...(c.audience || {}) },
      schedule: { ...(c.schedule || {}) },
    })
  }

  function draftPayload(c: CrmCampaign, d: Draft) {
    return {
      name: d.name.trim() || CAMPAIGN_KINDS[c.kind].label,
      channels: d.channels.length ? d.channels : ['email'],
      custom_body: d.custom_body.trim() || null,
      subject: d.subject.trim() || null,
      audience: d.audience,
      schedule: d.schedule,
    }
  }

  async function saveDraft(c: CrmCampaign) {
    if (!draft) return
    setSaving(true)
    const { error } = await supabase.from('crm_campaigns').update(draftPayload(c, draft)).eq('id', c.id)
    setSaving(false)
    if (error) { toast.error('Could not save: ' + error.message); return }
    setEditingId(null); setDraft(null); load()
  }

  // Save the current draft as a reusable preset. Upserts on (user_id, name) so
  // saving twice under one name updates rather than stacking duplicates.
  async function saveAsPreset(c: CrmCampaign) {
    if (!draft || !uid) return
    const p = draftPayload(c, draft)
    const { error } = await supabase.from('crm_campaign_presets').upsert({
      user_id: uid, name: p.name, kind: c.kind, channels: p.channels,
      template_key: null, custom_body: p.custom_body, subject: p.subject,
      audience: p.audience, schedule: p.schedule,
    }, { onConflict: 'user_id,name' })
    if (error) { toast.error('Could not save preset: ' + error.message); return }
    toast.success(`Saved “${p.name}” as a preset.`)
    load()
  }

  async function toggleEnabled(c: CrmCampaign) {
    // Turning a campaign ON starts sending real messages to real customers on the
    // next run, and there is no unsend. Confirm with the actual number, resolved
    // by the same audience engine the cron sends with — not a guess. Turning OFF
    // is safe and instant, so it isn't gated.
    if (!c.enabled && uid) {
      const template = (c.template_key || CAMPAIGN_KINDS[c.kind].defaultTemplate) as MsgType
      const channels = c.channels?.length ? c.channels : CAMPAIGN_KINDS[c.kind].defaultChannels
      let detail = ''
      try {
        const p = await previewAudience(supabase, {
          userId: uid, kind: c.kind, schedule: c.schedule || {}, audience: c.audience || {}, today: new Date(),
        }, channels, template)
        detail = p.reachable === 0
          ? 'No customers can be reached with the current filters and consent, so nothing will send yet.'
          : `${p.reachable} customer${p.reachable === 1 ? '' : 's'} can be reached. ${describeNextRun(c, new Date())}.`
      } catch {
        // Never block enabling on a failed preview — just don't claim a number.
        detail = describeNextRun(c, new Date()) + '.'
      }
      const go = await confirmDialog({
        title: `Turn on “${c.name}”?`,
        message: `${detail} Each customer receives it at most once per period.`,
        confirmLabel: 'Turn it on',
        icon: Send,
      })
      if (!go) return
    }
    // A swallowed error that leaves the UI "on" while the save failed is
    // dangerous. Revert + tell them.
    setCampaigns(prev => prev.map(x => x.id === c.id ? { ...x, enabled: !x.enabled } : x))
    const { error } = await supabase.from('crm_campaigns').update({ enabled: !c.enabled }).eq('id', c.id)
    if (error) {
      setCampaigns(prev => prev.map(x => x.id === c.id ? { ...x, enabled: c.enabled } : x))
      toast.error('Could not update that automation. Please try again.')
    }
  }

  // Duplicate an existing campaign — always disabled, so a copy can never start
  // sending on creation.
  async function duplicate(c: CrmCampaign) {
    if (!uid) return
    const { data, error } = await supabase.from('crm_campaigns').insert({
      user_id: uid, name: `${c.name} (copy)`, kind: c.kind, enabled: false,
      channels: c.channels, template_key: c.template_key, custom_body: c.custom_body,
      subject: c.subject, audience: c.audience, schedule: c.schedule,
    }).select().single()
    if (error || !data) { toast.error('Could not duplicate: ' + error?.message); return }
    await load()
    startEdit(data as CrmCampaign)
  }
  // Archive, never DELETE. crm_campaign_log.campaign_id cascades, so a hard delete
  // destroyed the campaign's whole send history — which is simultaneously the CASL
  // audit trail AND the per-period dedupe ledger. The Undo then re-inserted the row
  // enabled, with an empty ledger, so the next run happily messaged every customer a
  // second time. Archiving keeps the log, so Undo is just a flag flip.
  async function del(c: CrmCampaign) {
    const wasEnabled = c.enabled
    const { error } = await supabase.from('crm_campaigns')
      .update({ archived_at: new Date().toISOString(), enabled: false }).eq('id', c.id)
    if (error) { toast.error('Could not delete: ' + error.message); return }
    if (editingId === c.id) { setEditingId(null); setDraft(null) }
    load()
    toast.undo(`Deleted "${c.name}"`, async () => {
      await supabase.from('crm_campaigns').update({ archived_at: null, enabled: wasEnabled }).eq('id', c.id)
      load()
    })
  }
  async function delPreset(p: CrmCampaignPreset) {
    await supabase.from('crm_campaign_presets').delete().eq('id', p.id)
    load()
    toast.undo(`Removed preset "${p.name}"`, async () => {
      await supabase.from('crm_campaign_presets').insert(p); load()
    })
  }

  function setSchedule(p: Partial<CampaignSchedule>) {
    if (!draft) return
    setDraft({ ...draft, schedule: { ...draft.schedule, ...p } })
  }
  function setAudience(k: keyof CampaignAudience, on: boolean) {
    if (!draft) return
    const next = { ...draft.audience }
    if (on) next[k] = true; else delete next[k]
    setDraft({ ...draft, audience: next })
  }
  function toggleChannel(ch: string) {
    if (!draft) return
    setDraft({ ...draft, channels: draft.channels.includes(ch) ? draft.channels.filter(c => c !== ch) : [...draft.channels, ch] })
  }

  // How many customers this campaign could reach, in the owner's words.
  function audienceHint(c: CrmCampaign, d: Draft): string {
    if (c.kind === 'birthday') return `${counts.birthday} of ${counts.total} customers have a birthday set`
    if (c.kind === 'anniversary') return `${counts.anniversary} of ${counts.total} customers have an anniversary set`
    if (c.kind === 'win_back') return 'Quiet customers, when they pass the window'
    if (c.kind === 'review' && d.audience.not_reviewed) return `${counts.notReviewed} of ${counts.total} customers haven’t been asked yet`
    if (c.kind === 'referral' && d.audience.happy_only) return `${counts.happy} of ${counts.total} customers reviewed you 4★ or better`
    return `Up to ${counts.total} customers${d.audience.recurring_only ? ' (recurring only)' : ''}`
  }

  const enabledCount = campaigns.filter(c => c.enabled).length

  const menuItems = [
    ...CAMPAIGN_PRESETS.map((p, i) => ({
      key: `builtin-${i}`,
      label: p.name,
      description: p.seasonalKey
        ? SEASONAL_TEMPLATES.find(s => s.key === p.seasonalKey)?.blurb ?? CAMPAIGN_KINDS[p.kind].blurb
        : CAMPAIGN_KINDS[p.kind].blurb,
      icon: KIND_ICON[p.kind],
      onSelect: () => createFrom(p),
    })),
    ...presets.map(p => ({
      key: `saved-${p.id}`,
      label: p.name,
      description: `Your saved preset · ${CAMPAIGN_KINDS[p.kind].label}`,
      icon: Bookmark,
      onSelect: () => createFrom(p),
    })),
  ]

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden animate-rise">
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <Megaphone className="w-4 h-4 text-accent-text" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold tracking-tight text-ink">Automated messages</p>
          <p className="text-xs text-ink-muted tabular-nums">{loading ? 'Loading…' : `${campaigns.length} automation${campaigns.length !== 1 ? 's' : ''} · ${enabledCount} active`}</p>
        </div>
        <Menu
          align="end"
          width={340}
          ariaLabel="New campaign"
          className="shrink-0"
          items={menuItems}>
          {({ toggle, triggerProps }) => (
            <Button size="sm" onClick={toggle} loading={creating} {...triggerProps}><Plus className="w-3.5 h-3.5" /> New automation</Button>
          )}
        </Menu>
      </div>

      {loading ? (
        <div className="divide-y divide-border" aria-hidden="true">
          {[0, 1, 2].map(i => (
            <div key={i} className="px-4 py-3 flex items-center gap-3">
              <Skeleton className="w-9 h-9 rounded-xl shrink-0" />
              <div className="flex-1 min-w-0"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-2.5 w-48 mt-1.5" /></div>
              <Skeleton className="w-10 h-6 rounded-full shrink-0" />
            </div>
          ))}
        </div>
      ) : campaigns.length === 0 ? (
        <InlineEmpty icon={Megaphone}>No automated messages yet. Tap <span className="text-ink font-medium">New automation</span> to add a seasonal offer, referral ask, review chase, birthday greeting, win-back, or recurring check-in.</InlineEmpty>
      ) : (
        <div className="divide-y divide-border">
          {campaigns.map(c => {
            const Icon = KIND_ICON[c.kind]
            const meta = CAMPAIGN_KINDS[c.kind]
            const isEditing = editingId === c.id
            const templateKey = (c.template_key || meta.defaultTemplate) as MsgType
            const stats = statsById[c.id] ?? EMPTY_STATS
            return (
              <div key={c.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-accent-text" />
                  </div>
                  <button type="button" onClick={() => (isEditing ? setEditingId(null) : startEdit(c))} aria-expanded={isEditing} className="min-w-0 flex-1 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <p className="text-sm font-semibold text-ink truncate flex items-center gap-1.5">{c.name} <ChevronDown className={cn('w-3.5 h-3.5 text-ink-faint transition-transform', isEditing && 'rotate-180')} /></p>
                    <p className="text-xs text-ink-muted truncate">{describeSchedule(c)} · {(c.channels || []).map(x => x === 'sms' ? 'SMS' : 'Email').join(' + ') || '—'}</p>
                    {/* The rule above says WHEN it can fire; this says when it
                        next actually will — and only for a campaign that's on,
                        because a disabled one isn't going to send at all. */}
                    <p className="text-[11px] text-ink-faint truncate tabular-nums">
                      {c.enabled ? describeNextRun(c, new Date()) : 'Off'} · {summarizeStats(stats)}
                    </p>
                  </button>
                  <div className="shrink-0"><Toggle checked={c.enabled} onChange={() => toggleEnabled(c)} ariaLabel={`${c.enabled ? 'Disable' : 'Enable'} ${c.name}`} /></div>
                </div>

                {isEditing && draft && (
                  <div className="mt-3 pl-0 sm:pl-12 space-y-3">
                    <Input label="Name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />

                    {/* Schedule — the control depends on the kind's `timing`. */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">When it sends</span>
                      {meta.timing === 'lead_days' && (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                          <input type="number" inputMode="numeric" min={0} max={30} aria-label="Days before" value={draft.schedule.lead_days ?? 0} onChange={e => setSchedule({ lead_days: Math.max(0, Number(e.target.value) || 0) })}
                            className={cn('w-20', NUM_INPUT)} />
                          days before the {c.kind === 'birthday' ? 'birthday' : 'anniversary'} (0 = on the day)
                        </div>
                      )}
                      {meta.timing === 'quiet_days' && (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                          After <input type="number" inputMode="numeric" min={7} max={365} aria-label="Days with no message" value={draft.schedule.days ?? 45} onChange={e => setSchedule({ days: Math.max(7, Number(e.target.value) || 45) })}
                            className={cn('w-20', NUM_INPUT)} /> days with no message
                        </div>
                      )}
                      {meta.timing === 'monthly' && (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                          On day <input type="number" inputMode="numeric" min={1} max={28} aria-label="Day of month" value={draft.schedule.day_of_month ?? 1} onChange={e => setSchedule({ day_of_month: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
                            className={cn('w-16', NUM_INPUT)} />
                          <select value={draft.schedule.every_months ?? 1} aria-label="Frequency" onChange={e => setSchedule({ every_months: Number(e.target.value) })}
                            className={NUM_INPUT}>
                            <option value={1}>every month</option>
                            <option value={3}>every 3 months</option>
                            <option value={6}>every 6 months</option>
                            <option value={12}>every year</option>
                          </select>
                        </div>
                      )}
                      {meta.timing === 'calendar_date' && (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                          Every
                          <select value={draft.schedule.month ?? 4} aria-label="Month" onChange={e => setSchedule({ month: Number(e.target.value) })}
                            className={NUM_INPUT}>
                            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                          </select>
                          <input type="number" inputMode="numeric" min={1} max={28} aria-label="Day of month" value={draft.schedule.day ?? 1} onChange={e => setSchedule({ day: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
                            className={cn('w-16', NUM_INPUT)} />
                        </div>
                      )}

                      {/* Active window — applies to every kind. This is how a seasonal
                          campaign stops on its own instead of relying on the owner
                          remembering to switch it off. */}
                      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                        <span className="text-xs text-ink-faint">Only run between</span>
                        <input type="date" aria-label="Start date" value={draft.schedule.starts_on ?? ''} onChange={e => setSchedule({ starts_on: e.target.value || undefined })} className={NUM_INPUT} />
                        <span className="text-xs text-ink-faint">and</span>
                        <input type="date" aria-label="End date" value={draft.schedule.ends_on ?? ''} onChange={e => setSchedule({ ends_on: e.target.value || undefined })} className={NUM_INPUT} />
                      </div>
                      <p className="text-[11px] text-ink-faint">Leave the dates blank to run indefinitely. {audienceHint(c, draft)}.</p>
                    </div>

                    {/* Channels */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Send by</span>
                      <div className="flex gap-2">
                        {['sms', 'email'].map(ch => (
                          <FilterPill key={ch} active={draft.channels.includes(ch)} onClick={() => toggleChannel(ch)}>
                            {ch === 'sms' ? 'SMS' : 'Email'}
                          </FilterPill>
                        ))}
                      </div>
                    </div>

                    {/* Audience — only the switches that mean something for this kind. */}
                    {meta.audienceKeys.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Who it goes to</span>
                        {meta.audienceKeys.map(k => (
                          <label key={k} className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
                            <input type="checkbox" checked={!!draft.audience[k]} onChange={e => setAudience(k, e.target.checked)} className="w-4 h-4 accent-accent" />
                            {AUDIENCE_LABELS[k]}
                          </label>
                        ))}
                      </div>
                    )}

                    {/* Subject — email only, so don't ask for one on an SMS-only campaign. */}
                    {draft.channels.includes('email') && (
                      <div className="flex flex-col gap-1.5">
                        <Input label="Email subject" value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} placeholder="Leave blank to use the default" />
                      </div>
                    )}

                    {/* Message */}
                    <div className="flex flex-col gap-1.5">
                      <Textarea label="Message" value={draft.custom_body} onChange={e => setDraft({ ...draft, custom_body: e.target.value })} rows={5} placeholder={DEFAULT_TEMPLATES[templateKey]} />
                      <p className="text-[11px] text-ink-faint">Leave blank to use the default above.</p>
                      {/* The same variable affordance the Settings template editor
                          offers, narrowed to the tokens a campaign can actually
                          fill — offering {{amount}} here would render nothing. */}
                      <div className="flex flex-wrap gap-1">
                        {MSG_VARIABLES.filter(v => CAMPAIGN_VARS.has(v.key)).map(v => (
                          <code key={v.key} title={v.hint}
                            className="text-[10px] rounded-md border border-border bg-surface px-1.5 py-0.5 text-ink-muted">
                            {`{{${v.key}}}`}
                          </code>
                        ))}
                      </div>
                    </div>

                    {/* Who + what, resolved by the same engines that send. */}
                    {uid && (
                      <div className="pt-1 border-t border-border">
                        <div className="pt-3">
                          <CampaignPreview
                            userId={uid}
                            kind={c.kind}
                            schedule={draft.schedule}
                            audience={draft.audience}
                            channels={draft.channels}
                            template={templateKey}
                            customBody={draft.custom_body}
                            subject={draft.subject}
                            businessName={biz.name}
                            reviewUrl={biz.reviewUrl}
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button size="sm" onClick={() => saveDraft(c)} loading={saving}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setDraft(null) }}>Cancel</Button>
                      <Button size="sm" variant="secondary" onClick={() => saveAsPreset(c)}><Bookmark className="w-3.5 h-3.5" /> Save as preset</Button>
                      <Button size="sm" variant="ghost" onClick={() => duplicate(c)} aria-label="Duplicate automation" title="Duplicate"><Copy className="w-4 h-4" /></Button>
                      <Button size="sm" variant="ghost" className="ml-auto text-red-400/70 hover:text-red-400" onClick={() => del(c)} aria-label="Delete automation" title="Delete"><Trash2 className="w-4 h-4" /></Button>
                    </div>

                    <div className="pt-1 border-t border-border">
                      <div className="pt-3"><CampaignHistory campaignId={c.id} stats={stats} /></div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Saved presets — visible so they're manageable, not just a hidden menu. */}
      {!loading && presets.length > 0 && (
        <div className="px-4 py-3 border-t border-border">
          <span className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Your saved presets</span>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {presets.map(p => (
              <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface pl-2.5 pr-1 py-1 text-xs text-ink-muted">
                <Bookmark className="w-3 h-3 text-ink-faint" />
                {p.name}
                <button type="button" onClick={() => delPreset(p)} aria-label={`Remove preset ${p.name}`} title="Remove preset"
                  className="rounded-full p-0.5 text-ink-faint hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
