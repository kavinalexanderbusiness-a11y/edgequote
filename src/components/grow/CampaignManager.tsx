'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeRefresh } from '@/hooks/useRealtime'
import { Button } from '@/components/ui/Button'
import { CrmCampaign, CampaignKind } from '@/types'
import { DEFAULT_TEMPLATES, MsgType } from '@/lib/comms/templates'
import { CAMPAIGN_KINDS, CAMPAIGN_PRESETS, describeSchedule } from '@/lib/crm/campaigns'
import { cn } from '@/lib/utils'
import { Megaphone, Cake, PartyPopper, Coffee, Repeat, Plus, Trash2, ChevronDown, Loader2 } from 'lucide-react'

const KIND_ICON: Record<CampaignKind, typeof Cake> = {
  birthday: Cake, anniversary: PartyPopper, win_back: Coffee, broadcast: Repeat,
}

interface Draft {
  name: string
  channels: string[]
  custom_body: string
  recurring_only: boolean
  schedule: CrmCampaign['schedule']
}

// The unified Campaign Manager: birthday / anniversary / win-back / recurring
// marketing are all rows of crm_campaigns, sent daily by /api/cron/campaigns
// through the existing comms pipeline. Per-customer SMS/email consent still
// gates every send.
export function CampaignManager() {
  const supabase = useMemo(() => createClient(), [])
  const [uid, setUid] = useState<string | null>(null)
  const [campaigns, setCampaigns] = useState<CrmCampaign[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({ total: 0, birthday: 0, anniversary: 0 })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)

  async function load() {
    const { data: { user } } = await supabase.auth.getUser()
    setUid(user?.id || null)
    if (!user) { setLoading(false); return }
    const [campRes, totalRes, bdayRes, annivRes] = await Promise.all([
      supabase.from('crm_campaigns').select('*').eq('user_id', user.id).order('created_at', { ascending: true }),
      supabase.from('customers').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('archived_at', null),
      supabase.from('customers').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('archived_at', null).not('birthday', 'is', null),
      supabase.from('customers').select('id', { count: 'exact', head: true }).eq('user_id', user.id).is('archived_at', null).not('anniversary', 'is', null),
    ])
    setCampaigns((campRes.data as CrmCampaign[]) || [])
    setStats({ total: totalRes.count || 0, birthday: bdayRes.count || 0, anniversary: annivRes.count || 0 })
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useRealtimeRefresh('crm_campaigns', uid ? `user_id=eq.${uid}` : null, load)

  async function createFromPreset(presetIdx: number) {
    if (!uid) return
    const p = CAMPAIGN_PRESETS[presetIdx]
    setPicking(false); setCreating(true)
    const { data, error } = await supabase.from('crm_campaigns').insert({
      user_id: uid, name: p.name, kind: p.kind, enabled: false,
      channels: p.channels, template_key: null, custom_body: null,
      audience: p.audience, schedule: p.schedule,
    }).select().single()
    setCreating(false)
    if (error || !data) { alert('Could not create campaign: ' + error?.message); return }
    await load()
    startEdit(data as CrmCampaign)
  }

  function startEdit(c: CrmCampaign) {
    setEditingId(c.id)
    setDraft({
      name: c.name,
      channels: c.channels?.length ? [...c.channels] : ['email'],
      custom_body: c.custom_body || '',
      recurring_only: !!c.audience?.recurring_only,
      schedule: { ...c.schedule },
    })
  }

  async function saveDraft(c: CrmCampaign) {
    if (!draft) return
    setSaving(true)
    const { error } = await supabase.from('crm_campaigns').update({
      name: draft.name.trim() || CAMPAIGN_KINDS[c.kind].label,
      channels: draft.channels.length ? draft.channels : ['email'],
      custom_body: draft.custom_body.trim() || null,
      audience: { recurring_only: draft.recurring_only },
      schedule: draft.schedule,
    }).eq('id', c.id)
    setSaving(false)
    if (error) { alert('Could not save: ' + error.message); return }
    setEditingId(null); setDraft(null); load()
  }

  async function toggleEnabled(c: CrmCampaign) {
    setCampaigns(prev => prev.map(x => x.id === c.id ? { ...x, enabled: !x.enabled } : x))
    await supabase.from('crm_campaigns').update({ enabled: !c.enabled }).eq('id', c.id)
  }
  async function del(c: CrmCampaign) {
    if (!confirm(`Delete the "${c.name}" campaign? This stops it sending and removes its history.`)) return
    await supabase.from('crm_campaigns').delete().eq('id', c.id)
    if (editingId === c.id) { setEditingId(null); setDraft(null) }
    load()
  }

  function setSchedule(p: Partial<CrmCampaign['schedule']>) {
    if (!draft) return
    setDraft({ ...draft, schedule: { ...draft.schedule, ...p } })
  }
  function toggleChannel(ch: string) {
    if (!draft) return
    setDraft({ ...draft, channels: draft.channels.includes(ch) ? draft.channels.filter(c => c !== ch) : [...draft.channels, ch] })
  }

  const enabledCount = campaigns.filter(c => c.enabled).length

  return (
    <div className="rounded-card border border-border bg-bg-secondary overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
          <Megaphone className="w-4.5 h-4.5 text-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold text-ink">Campaigns</p>
          <p className="text-xs text-ink-muted">{loading ? 'Loading…' : `${campaigns.length} campaign${campaigns.length !== 1 ? 's' : ''} · ${enabledCount} active`}</p>
        </div>
        <div className="relative shrink-0">
          <Button size="sm" onClick={() => setPicking(p => !p)} loading={creating}><Plus className="w-3.5 h-3.5" /> New</Button>
          {picking && (
            <div className="absolute right-0 mt-1 w-60 rounded-xl border border-border bg-surface shadow-lg z-10 overflow-hidden">
              {CAMPAIGN_PRESETS.map((p, i) => {
                const Icon = KIND_ICON[p.kind]
                return (
                  <button key={i} onClick={() => createFromPreset(i)} className="w-full text-left px-3 py-2.5 hover:bg-surface-raised flex items-center gap-2.5 border-b border-border last:border-0">
                    <Icon className="w-4 h-4 text-accent shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{p.name}</p>
                      <p className="text-[11px] text-ink-faint truncate">{CAMPAIGN_KINDS[p.kind].blurb}</p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {!loading && campaigns.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-ink-muted">No campaigns yet. Tap <span className="text-ink font-medium">New</span> to add a birthday greeting, anniversary thank-you, win-back, or recurring check-in.</p>
      ) : (
        <div className="divide-y divide-border">
          {campaigns.map(c => {
            const Icon = KIND_ICON[c.kind]
            const isEditing = editingId === c.id
            const templateKey = (c.template_key || CAMPAIGN_KINDS[c.kind].defaultTemplate) as MsgType
            const hint = c.kind === 'birthday' ? `${stats.birthday} of ${stats.total} customers have a birthday set`
              : c.kind === 'anniversary' ? `${stats.anniversary} of ${stats.total} customers have an anniversary set`
              : c.kind === 'broadcast' ? `Up to ${stats.total} customers${c.audience?.recurring_only ? ' (recurring only)' : ''}`
              : 'Quiet customers, when they pass the window'
            return (
              <div key={c.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-accent" />
                  </div>
                  <button onClick={() => (isEditing ? setEditingId(null) : startEdit(c))} className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-semibold text-ink truncate flex items-center gap-1.5">{c.name} <ChevronDown className={cn('w-3.5 h-3.5 text-ink-faint transition-transform', isEditing && 'rotate-180')} /></p>
                    <p className="text-xs text-ink-muted truncate">{describeSchedule(c)} · {(c.channels || []).map(x => x === 'sms' ? 'SMS' : 'Email').join(' + ') || '—'}{c.last_run_at ? ` · last ran ${new Date(c.last_run_at).toLocaleDateString()}` : ''}</p>
                  </button>
                  <button onClick={() => toggleEnabled(c)} role="switch" aria-checked={c.enabled} title={c.enabled ? 'On' : 'Off'}
                    className={cn('w-11 h-6 rounded-full border transition-colors shrink-0 relative', c.enabled ? 'bg-accent border-accent' : 'bg-bg-tertiary border-border')}>
                    <span className={cn('absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all', c.enabled ? 'left-[22px]' : 'left-0.5')} />
                  </button>
                </div>

                {isEditing && draft && (
                  <div className="mt-3 pl-12 space-y-3">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-ink-faint uppercase tracking-wide">Name</label>
                      <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })}
                        className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
                    </div>

                    {/* Schedule — depends on kind */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-ink-faint uppercase tracking-wide">When it sends</label>
                      {(c.kind === 'birthday' || c.kind === 'anniversary') && (
                        <div className="flex items-center gap-2 text-sm text-ink-muted">
                          <input type="number" min={0} max={30} value={draft.schedule.lead_days ?? 0} onChange={e => setSchedule({ lead_days: Math.max(0, Number(e.target.value) || 0) })}
                            className="w-20 bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
                          days before the {c.kind === 'birthday' ? 'birthday' : 'anniversary'} (0 = on the day)
                        </div>
                      )}
                      {c.kind === 'win_back' && (
                        <div className="flex items-center gap-2 text-sm text-ink-muted">
                          After <input type="number" min={7} max={365} value={draft.schedule.days ?? 45} onChange={e => setSchedule({ days: Math.max(7, Number(e.target.value) || 45) })}
                            className="w-20 bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-accent" /> days with no message
                        </div>
                      )}
                      {c.kind === 'broadcast' && (
                        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
                          On day <input type="number" min={1} max={28} value={draft.schedule.day_of_month ?? 1} onChange={e => setSchedule({ day_of_month: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })}
                            className="w-16 bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
                          <select value={draft.schedule.every_months ?? 1} onChange={e => setSchedule({ every_months: Number(e.target.value) })}
                            className="bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-sm text-ink outline-none focus:border-accent">
                            <option value={1}>every month</option>
                            <option value={3}>every 3 months</option>
                            <option value={6}>every 6 months</option>
                            <option value={12}>every year</option>
                          </select>
                        </div>
                      )}
                      <p className="text-[11px] text-ink-faint">{hint}</p>
                    </div>

                    {/* Channels */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-ink-faint uppercase tracking-wide">Send by</label>
                      <div className="flex gap-2">
                        {['sms', 'email'].map(ch => (
                          <button key={ch} onClick={() => toggleChannel(ch)}
                            className={cn('text-xs font-semibold rounded-full px-3 py-1 border transition-colors', draft.channels.includes(ch) ? 'bg-accent text-black border-accent' : 'border-border text-ink-muted hover:text-ink')}>
                            {ch === 'sms' ? 'SMS' : 'Email'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Audience */}
                    {c.kind !== 'win_back' && (
                      <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
                        <input type="checkbox" checked={draft.recurring_only} onChange={e => setDraft({ ...draft, recurring_only: e.target.checked })} className="accent-accent" />
                        Only send to recurring customers
                      </label>
                    )}

                    {/* Message */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-ink-faint uppercase tracking-wide">Message</label>
                      <textarea value={draft.custom_body} onChange={e => setDraft({ ...draft, custom_body: e.target.value })}
                        rows={5} placeholder={DEFAULT_TEMPLATES[templateKey]}
                        className="w-full bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2 text-sm text-ink placeholder:text-ink-faint/70 outline-none focus:border-accent resize-y" />
                      <p className="text-[11px] text-ink-faint">Leave blank to use the default above. Use <code className="text-ink-muted">{'{{first_name}}'}</code> and <code className="text-ink-muted">{'{{business_name}}'}</code>.</p>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <Button size="sm" onClick={() => saveDraft(c)} loading={saving}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingId(null); setDraft(null) }}>Cancel</Button>
                      <button onClick={() => del(c)} className="ml-auto p-1.5 rounded-lg text-ink-faint hover:text-red-400 hover:bg-surface-raised" title="Delete campaign"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {loading && <p className="px-5 py-8 text-center text-sm text-ink-muted flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>}
    </div>
  )
}
