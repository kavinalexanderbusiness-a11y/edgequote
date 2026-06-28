'use client'

import { useState } from 'react'
import { toast } from '@/lib/toast'
import type { MsgType } from '@/lib/comms/templates'
import { Button } from '@/components/ui/Button'
import { MessageSquare, Mail, Send, X, Check } from 'lucide-react'

// Shared bulk send — texts/emails the owner's saved template to many customers at once
// through the SAME /api/comms/send pipeline (opt-in-gated, logged, threaded). Lists pass
// the relevant templates (e.g. quote reminder, review request). Reuses one engine.

export interface BulkTemplate { value: MsgType; label: string }

const DEFAULT_TEMPLATES: BulkTemplate[] = [
  { value: 'review_request', label: 'Request a Google review' },
  { value: 'thanks', label: 'Thank you' },
  { value: 'win_back', label: 'Win-back — we miss you' },
  { value: 'marketing', label: 'Promotion / update' },
]

export function BulkMessageDialog({ customerIds, templates = DEFAULT_TEMPLATES, title = 'Message selected', onClose }: {
  customerIds: string[]
  templates?: BulkTemplate[]
  title?: string
  onClose: (sent?: number) => void
}) {
  const [template, setTemplate] = useState<MsgType>(templates[0]?.value as MsgType)
  const [ch, setCh] = useState<{ sms: boolean; email: boolean }>({ sms: true, email: true })
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)

  async function send() {
    const channels = (['sms', 'email'] as const).filter(c => ch[c])
    if (!channels.length) { toast.error('Pick at least one channel.'); return }
    setBusy(true); setProgress(0)
    let sent = 0, skipped = 0
    for (let i = 0; i < customerIds.length; i++) {
      try {
        const res = await fetch('/api/comms/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: customerIds[i], template, channels }),
        })
        const d = (await res.json().catch(() => ({}))) as { results?: Record<string, { sent?: boolean }> }
        if (Object.values(d.results || {}).some(r => r?.sent)) sent++; else skipped++
      } catch { skipped++ }
      setProgress(i + 1)
    }
    setBusy(false)
    toast.success(`Sent to ${sent} customer${sent !== 1 ? 's' : ''}${skipped ? ` · ${skipped} skipped (no opt-in or contact on file)` : ''}.`)
    onClose(sent)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !busy && onClose()}>
      <div className="bg-bg-secondary border border-border-strong rounded-card max-w-md w-full p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-ink flex items-center gap-2"><Send className="w-4 h-4 text-accent" /> {title} · {customerIds.length}</p>
          <button onClick={() => !busy && onClose()} className="text-ink-faint hover:text-ink" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <label className="block text-[10px] uppercase tracking-wide text-ink-faint">Message
          <select value={template} onChange={e => setTemplate(e.target.value as MsgType)}
            className="w-full mt-1 bg-bg-tertiary border border-border-strong rounded-xl px-3 py-2.5 text-sm text-ink outline-none focus:border-accent">
            {templates.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <ChannelChip label="SMS" icon={MessageSquare} on={ch.sms} onClick={() => setCh(c => ({ ...c, sms: !c.sms }))} />
          <ChannelChip label="Email" icon={Mail} on={ch.email} onClick={() => setCh(c => ({ ...c, email: !c.email }))} />
        </div>

        <p className="text-[11px] text-ink-faint">Each customer gets your saved template, personalized. Anyone who hasn&apos;t opted in (or has no phone/email) is skipped automatically.</p>

        <div className="flex items-center gap-2">
          <Button onClick={send} loading={busy}><Send className="w-3.5 h-3.5" /> {busy ? `Sending ${progress}/${customerIds.length}…` : `Send to ${customerIds.length}`}</Button>
          <Button variant="ghost" onClick={() => onClose()} disabled={busy}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}

function ChannelChip({ label, icon: Icon, on, onClick }: { label: string; icon: typeof Mail; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`h-8 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1 transition-colors ${on ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border text-ink-faint hover:text-ink'}`}>
      <Icon className="w-3.5 h-3.5" /> {label} {on && <Check className="w-3 h-3" />}
    </button>
  )
}
