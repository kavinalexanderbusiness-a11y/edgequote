'use client'

import { useState } from 'react'
import { MsgType } from '@/lib/comms/templates'
import { cn } from '@/lib/utils'
import { MessageSquare, Mail, Send, Loader2, Check, AlertTriangle } from 'lucide-react'

// Reusable "Send by SMS / Email / Both" control — used for quotes and invoices.
// Routes through /api/comms/send (owner session, opt-in-gated, logged). Stays
// honest: if a channel is off/not-opted-in/disabled, the result line says why.
interface Props {
  customerId: string | null
  template: MsgType
  label?: string
  jobId?: string | null
  vars?: { amount?: string; eta?: string | number }
}

interface Outcome { ok: boolean; text: string }

export function SendComms({ customerId, template, label = 'Send', jobId = null, vars }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  async function send(channels: ('sms' | 'email')[]) {
    if (!customerId) { setOutcome({ ok: false, text: 'No customer linked.' }); return }
    setBusy(channels.join('+')); setOutcome(null)
    try {
      const res = await fetch('/api/comms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, template, channels, jobId, vars }),
      })
      setOutcome(summarize(await res.json()))
    } catch (e) {
      setOutcome({ ok: false, text: e instanceof Error ? e.message : 'Failed to send.' })
    }
    setBusy(null)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-ink-faint mr-1">{label}:</span>
        <Btn busy={busy === 'sms'} disabled={busy !== null} onClick={() => send(['sms'])} icon={MessageSquare}>SMS</Btn>
        <Btn busy={busy === 'email'} disabled={busy !== null} onClick={() => send(['email'])} icon={Mail}>Email</Btn>
        <Btn busy={busy === 'sms+email'} disabled={busy !== null} onClick={() => send(['sms', 'email'])} icon={Send}>Both</Btn>
      </div>
      {outcome && (
        <div className={cn('flex items-start gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border max-w-md',
          outcome.ok ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10')}>
          {outcome.ok ? <Check className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span>{outcome.text}</span>
        </div>
      )}
    </div>
  )
}

function Btn({ children, icon: Icon, busy, disabled, onClick }: { children: React.ReactNode; icon: typeof Mail; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="h-8 px-2.5 rounded-lg border border-border text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/10 flex items-center gap-1.5 active:scale-95 transition-transform disabled:opacity-50">
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />} {children}
    </button>
  )
}

function summarize(data: { results?: Record<string, { sent?: boolean; reason?: string; error?: string }> }): Outcome {
  const r = data.results || {}
  const sent = Object.entries(r).filter(([, v]) => v.sent).map(([ch]) => ch)
  if (sent.length) return { ok: true, text: `Sent by ${sent.join(' & ')}.` }
  const reasons = Object.values(r).map(v => v.reason)
  if (reasons.includes('no-optin')) return { ok: false, text: 'Customer hasn’t opted in — turn on SMS/email on their profile.' }
  if (reasons.includes('disabled')) return { ok: false, text: 'Messaging is off — add Twilio/Resend keys in Settings.' }
  const err = Object.values(r).find(v => v.error)?.error
  if (err) return { ok: false, text: err }
  return { ok: false, text: 'Nothing sent (no phone/email on file).' }
}
