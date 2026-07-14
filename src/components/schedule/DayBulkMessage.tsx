'use client'

import { useEffect, useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { MsgType, renderMessage } from '@/lib/comms/templates'
import { SmsCost } from '@/components/comms/SmsCost'
import { Button } from '@/components/ui/Button'
import { InlineEmpty } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import type { Job } from '@/types'
import {
  Navigation, Clock, CalendarCheck, Bell, CloudRain, CalendarClock, Heart, Pencil,
  Send, Check, AlertTriangle, MessageSquare, Mail, Users,
} from 'lucide-react'
import { Modal } from '@/components/ui/Modal'

// One shared dialog to message everyone scheduled today — reuses the SAME comms
// engine as the per-job composer (/api/comms/send + renderMessage), so there's no
// second messaging system. Everyone's selected by default; deselect anyone; pick a
// template (or Custom); one Send fans out per recipient (each personalised by name),
// respecting per-customer opt-in and logging to their timeline like every other send.
interface BulkTemplate { key: string; type: MsgType; label: string; icon: typeof Navigation; needsEta?: boolean; reschedule?: 'date' | 'weather'; custom?: boolean }

const TEMPLATES: BulkTemplate[] = [
  { key: 'on_my_way', type: 'on_my_way', label: 'On my way', icon: Navigation, needsEta: true },
  { key: 'running_late', type: 'running_late', label: 'Running late', icon: Clock, needsEta: true },
  { key: 'confirm', type: 'confirm', label: 'Arriving today', icon: CalendarCheck },
  { key: 'reminder', type: 'reminder', label: 'Reminder', icon: Bell },
  { key: 'rain_delay', type: 'rain_delay', label: 'Weather delay', icon: CloudRain, reschedule: 'weather' },
  { key: 'rescheduled', type: 'rescheduled', label: 'Reschedule', icon: CalendarClock, reschedule: 'date' },
  { key: 'thanks', type: 'thanks', label: 'Thank you', icon: Heart },
  { key: 'custom', type: 'reminder', label: 'Custom', icon: Pencil, custom: true },
]

interface Recipient { customerId: string; name: string; jobId: string }

export function DayBulkMessage({ date, jobs, onClose }: { date: string; jobs: Job[]; onClose: () => void }) {
  const supabase = useMemo(() => createClient(), [])

  // Same dialog hygiene as every other schedule modal: Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Everyone scheduled today (active), deduped by customer — one message per person.
  const recipients = useMemo<Recipient[]>(() => {
    const seen = new Set<string>(); const out: Recipient[] = []
    for (const j of jobs) {
      if (j.status === 'cancelled' || !j.customer_id || seen.has(j.customer_id)) continue
      seen.add(j.customer_id)
      out.push({ customerId: j.customer_id, name: j.customers?.name || 'Customer', jobId: j.id })
    }
    return out
  }, [jobs])

  const [selected, setSelected] = useState<Set<string>>(() => new Set(recipients.map(r => r.customerId)))
  const [tplKey, setTplKey] = useState('confirm')
  const tpl = TEMPLATES.find(t => t.key === tplKey)!
  const [eta, setEta] = useState('15')
  const [newDate, setNewDate] = useState(date)
  const [oldDate, setOldDate] = useState(date)
  const [custom, setCustom] = useState('')
  const [ch, setCh] = useState({ sms: true, email: true })
  const [company, setCompany] = useState('Edge Property Services')
  const [reviewUrl, setReviewUrl] = useState('')
  const [customTpls, setCustomTpls] = useState<Partial<Record<MsgType, string>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ sent: number; notSent: number; note?: string } | null>(null)

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const uid = session?.user?.id
      if (!uid) return
      const { data } = await supabase.from('business_settings').select('company_name, review_url, message_templates').eq('user_id', uid).maybeSingle()
      const d = data as { company_name: string | null; review_url: string | null; message_templates: Partial<Record<MsgType, string>> | null } | null
      if (d?.company_name) setCompany(d.company_name)
      setReviewUrl(d?.review_url || '')
      setCustomTpls(d?.message_templates || {})
    })()
  }, [supabase])

  const fmtDate = (iso: string) => { try { return format(parseISO(iso + 'T00:00:00'), 'EEE, MMM d') } catch { return iso } }
  const selectedCount = recipients.filter(r => selected.has(r.customerId)).length
  const sample = recipients.find(r => selected.has(r.customerId)) || recipients[0] || null

  // Preview rendered exactly as it will send (for the first selected recipient).
  const previewText = tpl.custom
    ? custom
    : sample
      ? renderMessage(tpl.type, customTpls, {
          firstName: sample.name, businessName: company, eta,
          reviewLink: reviewUrl || undefined,
          dateLabel: tpl.reschedule ? fmtDate(newDate) : fmtDate(date),
          oldDateLabel: fmtDate(oldDate),
        }).sms
      : ''

  function toggle(id: string) { setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s }) }
  function selectAll() { setSelected(new Set(recipients.map(r => r.customerId))) }
  function selectNone() { setSelected(new Set()) }

  async function sendAll() {
    const targets = recipients.filter(r => selected.has(r.customerId))
    if (!targets.length) return
    const channels = (['sms', 'email'] as const).filter(c => ch[c])
    if (!channels.length) { setResult({ sent: 0, notSent: targets.length, note: 'Pick at least one channel.' }); return }
    if (tpl.custom && !custom.trim()) { setResult({ sent: 0, notSent: targets.length, note: 'Write a message first.' }); return }
    setBusy(true); setResult(null)
    let sent = 0, notSent = 0, disabled = false
    for (const r of targets) {
      try {
        const res = await fetch('/api/comms/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerId: r.customerId, template: tpl.type, jobId: r.jobId, channels,
            bodyOverride: tpl.custom ? custom : undefined,
            vars: { eta, dateLabel: tpl.reschedule ? fmtDate(newDate) : fmtDate(date), oldDateLabel: fmtDate(oldDate) },
          }),
        })
        const data = await res.json() as { enabled?: boolean; results?: Record<string, { sent?: boolean }> }
        if (data.enabled === false) disabled = true
        if (Object.values(data.results || {}).some(v => v.sent)) sent++; else notSent++
      } catch { notSent++ }
    }
    setBusy(false)
    setResult({ sent, notSent, note: disabled ? 'Messaging is off — add Twilio/Resend keys in Settings.' : notSent > 0 ? 'Some weren’t sent (no opt-in or no phone/email on file).' : undefined })
  }

  return (
    // THE shared Modal — Escape, scroll-lock, aria-modal and the one scrim for free.
    <Modal open onClose={onClose} title="Message today’s customers" icon={Users} size="lg">
        {recipients.length === 0 ? (
          <InlineEmpty>No customers scheduled today.</InlineEmpty>
        ) : (
          <div className="space-y-3">
            {/* Recipients — everyone selected by default; deselect anyone */}
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{selectedCount} of {recipients.length} selected</p>
              <div className="flex items-center gap-2 text-[11px] font-medium">
                <button type="button" onClick={selectAll} className="text-accent hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">All</button>
                <span className="text-ink-faint">·</span>
                <button type="button" onClick={selectNone} className="text-accent hover:underline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">None</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {recipients.map(r => {
                const on = selected.has(r.customerId)
                return (
                  <button key={r.customerId} onClick={() => toggle(r.customerId)}
                    className={cn('rounded-full px-2.5 py-1 text-xs border inline-flex items-center gap-1 transition-colors',
                      on ? 'bg-accent/15 border-accent/40 text-accent' : 'bg-surface border-border text-ink-faint hover:text-ink')}>
                    {on && <Check className="w-3 h-3" />} {r.name.split(' ')[0]}
                  </button>
                )
              })}
            </div>

            {/* Template */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1">
              {TEMPLATES.map(t => (
                <button key={t.key} onClick={() => setTplKey(t.key)}
                  className={cn('h-9 rounded-lg border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors',
                    tplKey === t.key ? 'border-accent bg-accent/15 text-accent' : 'border-border text-ink-muted hover:text-ink hover:bg-black/10')}>
                  <t.icon className="w-3.5 h-3.5" /> {t.label}
                </button>
              ))}
            </div>

            {/* Variable inputs */}
            {tpl.needsEta && (
              <label className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-faint">ETA (min)
                <input type="number" min="1" step="5" value={eta} onChange={e => setEta(e.target.value)}
                  className="w-16 bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
              </label>
            )}
            {tpl.reschedule && (
              <div className="flex flex-wrap items-center gap-3">
                {tpl.reschedule === 'weather' && (
                  <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint">From
                    <input type="date" value={oldDate} onChange={e => setOldDate(e.target.value)} className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                  </label>
                )}
                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint">To
                  <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} className="bg-bg-tertiary border border-border-strong rounded-lg px-2 py-1 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20" />
                </label>
              </div>
            )}

            {/* Preview / custom editor */}
            {tpl.custom ? (
              <textarea value={custom} onChange={e => setCustom(e.target.value)} rows={4} placeholder="Write your message…"
                className="w-full bg-bg-tertiary border border-border-strong rounded-lg px-3 py-2 text-sm text-ink outline-none transition-all focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none" />
            ) : (
              <div className="rounded-lg border border-border bg-bg-tertiary px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-faint mb-1">Preview{sample ? ` · to ${sample.name.split(' ')[0]}` : ''} (each is personalised)</p>
                <p className="text-sm text-ink whitespace-pre-wrap">{previewText}</p>
              </div>
            )}
            {ch.sms && <SmsCost text={previewText} />}

            {/* Channels + send */}
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              <ChannelChip label="SMS" icon={MessageSquare} on={ch.sms} onClick={() => setCh(c => ({ ...c, sms: !c.sms }))} />
              <ChannelChip label="Email" icon={Mail} on={ch.email} onClick={() => setCh(c => ({ ...c, email: !c.email }))} />
              <Button size="sm" className="ml-auto" onClick={sendAll} loading={busy} disabled={selectedCount === 0}>
                <Send className="w-3.5 h-3.5" /> Send to {selectedCount}
              </Button>
            </div>

            {result && (
              <div className={cn('flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border',
                result.sent > 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10')}>
                {result.sent > 0 ? <Check className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
                <span>Sent to {result.sent} of {result.sent + result.notSent}. {result.note || 'Saved to each customer’s timeline.'}</span>
              </div>
            )}
          </div>
        )}
    </Modal>
  )
}

function ChannelChip({ label, icon: Icon, on, onClick }: { label: string; icon: typeof Mail; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('h-7 px-2 rounded-lg border text-[11px] font-medium flex items-center gap-1 transition-colors',
        on ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-ink-faint hover:text-ink')}>
      <Icon className="w-3 h-3" /> {label} {on && <Check className="w-3 h-3" />}
    </button>
  )
}
